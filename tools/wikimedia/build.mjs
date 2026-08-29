#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SHARDS } from "../address-db/build.mjs";
import { pointInRings, readDbf, readShapes } from "../admin-boundary/build.mjs";
import { loadCandidates } from "./analyze.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const N03 = join(ROOT, "data/reference-source/mlit-n03/N03-20260101_GML.zip");
const OUTPUT = join(ROOT, "generated/address-db");
const PREF_TO_SHARD = new Map(SHARDS.flatMap(([shard, prefectures]) => prefectures.map((name) => [name, shard])));
const CELL = 10; // 0.1度。行政区域のbbox候補抽出だけに使い、最終判定はpolygonで行う。

function sql(value) { return `'${String(value ?? "").replaceAll("'", "''")}'`; }
function cellKey(lat, lng) { return `${Math.floor(lat * CELL)},${Math.floor(lng * CELL)}`; }
async function write(stream, value) {
  if (stream.write(value)) return;
  await new Promise((resolve, reject) => {
    const onDrain = () => { stream.off("error", onError); resolve(); };
    const onError = (error) => { stream.off("drain", onDrain); reject(error); };
    stream.once("drain", onDrain); stream.once("error", onError);
  });
}

export async function buildWikipedia({ n03 = N03, output = OUTPUT } = {}) {
  const candidates = await loadCandidates();
  const cells = new Map();
  for (const candidate of candidates.values()) {
    const key = cellKey(candidate.lat, candidate.lng);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(candidate);
  }

  await mkdir(output, { recursive: true });
  const streams = new Map(), reports = new Map();
  const table = "CREATE TABLE IF NOT EXISTS wikipedia_places(page_id INTEGER PRIMARY KEY,title TEXT NOT NULL,type TEXT NOT NULL DEFAULT '',lat_e6 INTEGER NOT NULL,lng_e6 INTEGER NOT NULL,grid_lat INTEGER NOT NULL,grid_lng INTEGER NOT NULL,source TEXT NOT NULL DEFAULT 'jawiki');\n";
  for (const [shard] of SHARDS) {
    const stream = createWriteStream(join(output, `${shard}.wikipedia.sql`));
    streams.set(shard, stream); reports.set(shard, { articles: 0 });
    await write(stream, `BEGIN;\n${table}DELETE FROM wikipedia_places WHERE source='jawiki';\n`);
  }

  const temporary = await mkdtemp(join(tmpdir(), "michikusa-wikipedia-"));
  try {
    const extracted = spawnSync("unzip", ["-qq", "-j", n03, "N03-20260101.shp", "N03-20260101.dbf", "-d", temporary], { encoding: "utf8" });
    if (extracted.status !== 0) throw new Error(extracted.stderr || "N03を展開できません");
    const rows = readDbf(join(temporary, "N03-20260101.dbf"));
    const assigned = new Set(); let shapeIndex = 0;
    for await (const rings of readShapes(join(temporary, "N03-20260101.shp"))) {
      const row = rows[shapeIndex++], shard = row && PREF_TO_SHARD.get(row.N03_001);
      if (!shard || !rings.length) continue;
      const points = rings.flat();
      let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
      for (const [lng, lat] of points) {
        minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      }
      for (let y = Math.floor(minLat / 1e6 * CELL); y <= Math.floor(maxLat / 1e6 * CELL); y++) {
        for (let x = Math.floor(minLng / 1e6 * CELL); x <= Math.floor(maxLng / 1e6 * CELL); x++) {
          for (const candidate of cells.get(`${y},${x}`) || []) {
            if (assigned.has(candidate.pageId)) continue;
            const latE6 = Math.round(candidate.lat * 1e6), lngE6 = Math.round(candidate.lng * 1e6);
            if (lngE6 < minLng || lngE6 > maxLng || latE6 < minLat || latE6 > maxLat) continue;
            if (!pointInRings(lngE6, latE6, rings)) continue;
            assigned.add(candidate.pageId); reports.get(shard).articles++;
            await write(streams.get(shard), `INSERT OR REPLACE INTO wikipedia_places VALUES(${candidate.pageId},${sql(candidate.title)},${sql(candidate.type)},${latE6},${lngE6},${Math.floor(candidate.lat*100)},${Math.floor(candidate.lng*100)},'jawiki');\n`);
          }
        }
      }
    }
    for (const [shard, stream] of streams) {
      await write(stream, "CREATE INDEX IF NOT EXISTS wikipedia_places_grid ON wikipedia_places(grid_lat,grid_lng);\nCOMMIT;\nPRAGMA optimize;\n");
      await new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve()));
      reports.get(shard).bytes = (await stat(join(output, `${shard}.wikipedia.sql`))).size;
    }
    return { candidates: candidates.size, assigned: assigned.size, excluded: candidates.size - assigned.size, shards: Object.fromEntries(reports) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWikipedia().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error); process.exitCode = 1;
  });
}
