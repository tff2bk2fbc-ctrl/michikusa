#!/usr/bin/env node
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SHARDS } from "../address-db/build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DEFAULT_RAIL = join(ROOT, "data/address-source/k8.zip");
const DEFAULT_GEONAMES = join(ROOT, "data/reference-source/geonames/JP.zip");
const DEFAULT_OUTPUT = join(ROOT, "generated/address-db");

function sql(value) { return `'${String(value ?? "").replaceAll("'", "''")}'`; }
function centroid(coordinates) {
  const points = coordinates.flat(Infinity).reduce((a, value, i, all) => i % 2 ? a : (a.push([value, all[i + 1]]), a), []);
  return points.reduce((a, [lng, lat]) => [a[0] + lng / points.length, a[1] + lat / points.length], [0, 0]);
}

async function write(stream, text) {
  if (stream.write(text)) return;
  await new Promise((resolve, reject) => {
    const onDrain = () => { stream.off("error", onError); resolve(); };
    const onError = (error) => { stream.off("drain", onDrain); reject(error); };
    stream.once("drain", onDrain); stream.once("error", onError);
  });
}

const FACILITY_CODES = new Set(["MUS","SHRN","TMPL","CH","CSTL","PAL","SCH","UNIV","LIBR","HSP","STDM"]);
const NATURE_L_CODES = new Set(["PRK","RESN","RESV"]);

function loadGeoNames(zip) {
  if (!existsSync(zip)) return [];
  const extracted = spawnSync("unzip", ["-p", zip, "JP.txt"], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (extracted.status !== 0) throw new Error("GeoNames日本データを展開できません");
  const places = [];
  for (const line of extracted.stdout.split("\n")) {
    const row = line.split("\t"); if (row.length < 9) continue;
    const featureClass = row[6], featureCode = row[7];
    const kind = featureClass === "H" || featureClass === "T" || NATURE_L_CODES.has(featureCode)
      ? "nature" : FACILITY_CODES.has(featureCode) ? "facility" : null;
    const lat = Number(row[4]), lng = Number(row[5]);
    if (!kind || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const japanese = String(row[3] || "").split(",").find((name) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name));
    // 施設名は日本語名がない場合、既存のGoogle Places検索に任せる。
    if (kind === "facility" && !japanese && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(row[1])) continue;
    places.push({ id: row[0], kind, name: japanese || row[1], detail: featureCode, lat, lng, source: "geonames" });
  }
  return places;
}

export async function buildPlaces({ rail = DEFAULT_RAIL, geonames = DEFAULT_GEONAMES, output = DEFAULT_OUTPUT } = {}) {
  if (!existsSync(rail)) throw new Error(`鉄道N02がありません: ${rail}`);
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "michikusa-places-"));
  const extracted = spawnSync("unzip", ["-qq", "-j", rail, "*/N02-25_Station.geojson", "-d", temporary], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(extracted.stderr || "鉄道データを展開できません");
  const collection = JSON.parse(await readFile(join(temporary, "N02-25_Station.geojson"), "utf8"));
  const stations = new Map();
  for (const feature of collection.features || []) {
    const p = feature.properties || {}, code = String(p.N02_005g || p.N02_005c || "");
    const [lng, lat] = centroid(feature.geometry?.coordinates || []);
    if (!code || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const current = stations.get(code) || { code, name: p.N02_005, lat: 0, lng: 0, count: 0, lines: new Set(), operators: new Set() };
    current.lat += lat; current.lng += lng; current.count++;
    if (p.N02_003) current.lines.add(p.N02_003); if (p.N02_004) current.operators.add(p.N02_004);
    stations.set(code, current);
  }
  const geoPlaces = loadGeoNames(geonames);
  const reports = [];
  for (const [shard] of SHARDS) {
    const path = join(output, `${shard}.places.sql`), stream = createWriteStream(path);
    await write(stream, "BEGIN;\nCREATE TABLE IF NOT EXISTS nearby_places(id TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',lat_e6 INTEGER NOT NULL,lng_e6 INTEGER NOT NULL,grid_lat INTEGER NOT NULL,grid_lng INTEGER NOT NULL,source TEXT NOT NULL,PRIMARY KEY(id,kind,source));\nCREATE TABLE IF NOT EXISTS address_units(id TEXT PRIMARY KEY,lg_code TEXT NOT NULL,machiaza_id TEXT NOT NULL,block TEXT NOT NULL DEFAULT '',house_number TEXT NOT NULL DEFAULT '',building TEXT NOT NULL DEFAULT '',lat_e6 INTEGER,lng_e6 INTEGER,source TEXT NOT NULL,effective_date TEXT NOT NULL DEFAULT '');\nDELETE FROM nearby_places WHERE source IN ('mlit-n02','geonames');\n");
    for (const station of stations.values()) {
      const lat = station.lat / station.count, lng = station.lng / station.count;
      const detail = [...station.lines].join("・");
      await write(stream, `INSERT OR REPLACE INTO nearby_places VALUES(${sql(station.code)},'station',${sql(station.name)},${sql(detail)},${Math.round(lat*1e6)},${Math.round(lng*1e6)},${Math.floor(lat*100)},${Math.floor(lng*100)},'mlit-n02');\n`);
    }
    for (const place of geoPlaces) {
      await write(stream, `INSERT OR REPLACE INTO nearby_places VALUES(${sql(place.id)},${sql(place.kind)},${sql(place.name)},${sql(place.detail)},${Math.round(place.lat*1e6)},${Math.round(place.lng*1e6)},${Math.floor(place.lat*100)},${Math.floor(place.lng*100)},${sql(place.source)});\n`);
    }
    await write(stream, "CREATE INDEX IF NOT EXISTS nearby_places_grid ON nearby_places(grid_lat,grid_lng,kind);\nCOMMIT;\nPRAGMA optimize;\n");
    await new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve()));
    reports.push({ shard, stations: stations.size, geonames: geoPlaces.length, bytes: (await stat(path)).size });
  }
  await rm(temporary, { recursive: true, force: true });
  return reports;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPlaces().then((reports) => reports.forEach((r) => console.log(`${r.shard}: ${r.stations} stations, ${r.geonames} GeoNames places, ${(r.bytes/1048576).toFixed(1)} MiB`))).catch((error) => { console.error(error); process.exitCode = 1; });
}
