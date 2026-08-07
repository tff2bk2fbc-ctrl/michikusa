#!/usr/bin/env node
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SHARDS } from "../address-db/build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DEFAULT_ZIP = join(ROOT, "data/reference-source/mlit-n03/N03-20260101_GML.zip");
const DEFAULT_OUTPUT = join(ROOT, "generated/address-db");
const PREF_TO_SHARD = new Map(SHARDS.flatMap(([shard, prefs]) => prefs.map((pref) => [pref, shard])));
const TOLERANCE_E6 = 50; // 約5m。境界の形を保ち、D1のSQL文100KB上限にも収める。

function parseArgs(argv) {
  const out = { zip: DEFAULT_ZIP, output: DEFAULT_OUTPUT };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--zip") out.zip = resolve(argv[++i]);
    else if (argv[i] === "--output") out.output = resolve(argv[++i]);
    else throw new Error(`不明なオプション: ${argv[i]}`);
  }
  return out;
}

function sql(value) { return `'${String(value ?? "").replaceAll("'", "''")}'`; }

export function simplifyRing(points, tolerance = TOLERANCE_E6) {
  if (points.length <= 5) return points;
  const closed = points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1];
  const source = closed ? points.slice(0, -1) : points.slice();
  const keep = new Uint8Array(source.length); keep[0] = 1; keep[source.length - 1] = 1;
  const stack = [[0, source.length - 1]], threshold = tolerance * tolerance;
  while (stack.length) {
    const [start, end] = stack.pop();
    const [ax, ay] = source[start], [bx, by] = source[end];
    const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
    let best = -1, bestDistance = threshold;
    for (let i = start + 1; i < end; i++) {
      const [px, py] = source[i];
      let distance;
      if (!length2) distance = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
        distance = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (distance > bestDistance) { bestDistance = distance; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([start, best], [best, end]); }
  }
  const result = source.filter((_, i) => keep[i]);
  if (result.length < 3) return points;
  result.push(result[0]);
  return result;
}

export function pointInRings(lngE6, latE6, rings) {
  let inside = false;
  for (const ring of rings) {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > latE6) !== (yj > latE6) && lngE6 < ((xj - xi) * (latE6 - yi)) / (yj - yi) + xi) hit = !hit;
    }
    if (hit) inside = !inside;
  }
  return inside;
}

function pushVarint(bytes, value) {
  let n = value;
  while (n >= 128) { bytes.push((n % 128) + 128); n = Math.floor(n / 128); }
  bytes.push(n);
}

function zigzag(value) { return value >= 0 ? value * 2 : -value * 2 - 1; }

export function encodeRings(rings) {
  const bytes = []; pushVarint(bytes, rings.length);
  for (const ring of rings) {
    pushVarint(bytes, ring.length);
    let previousLng = 0, previousLat = 0;
    for (const [lng, lat] of ring) {
      pushVarint(bytes, zigzag(lng - previousLng));
      pushVarint(bytes, zigzag(lat - previousLat));
      previousLng = lng; previousLat = lat;
    }
  }
  return `v1:${Buffer.from(bytes).toString("base64")}`;
}

export function decodeRings(encoded) {
  const bytes = Buffer.from(encoded.slice(3), "base64"); let offset = 0;
  const read = () => { let value = 0, scale = 1, byte; do { byte = bytes[offset++]; value += (byte & 127) * scale; scale *= 128; } while (byte & 128); return value; };
  const unzigzag = (value) => value % 2 ? -(value + 1) / 2 : value / 2;
  const rings = [], count = read();
  for (let r = 0; r < count; r++) {
    const ring = []; let lng = 0, lat = 0, points = read();
    while (points--) { lng += unzigzag(read()); lat += unzigzag(read()); ring.push([lng, lat]); }
    rings.push(ring);
  }
  return rings;
}

export function readDbf(path) {
  const data = readFileSync(path), records = data.readUInt32LE(4);
  const headerLength = data.readUInt16LE(8), recordLength = data.readUInt16LE(10), fields = [];
  for (let offset = 32; data[offset] !== 0x0d; offset += 32) {
    fields.push({ name: data.subarray(offset, offset + 11).toString("ascii").replace(/\0.*/, ""), length: data[offset + 16] });
  }
  const decoder = new TextDecoder("utf-8"), rows = [];
  for (let index = 0; index < records; index++) {
    let offset = headerLength + index * recordLength + 1; const row = {};
    for (const field of fields) { row[field.name] = decoder.decode(data.subarray(offset, offset + field.length)).trim(); offset += field.length; }
    rows.push(row);
  }
  return rows;
}

export async function* readShapes(path) {
  const stream = createReadStream(path, { start: 100 });
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 8) {
      const bytes = pending.readInt32BE(4) * 2;
      if (pending.length < 8 + bytes) break;
      const body = pending.subarray(8, 8 + bytes); pending = pending.subarray(8 + bytes);
      const type = body.readInt32LE(0);
      if (type === 0) { yield []; continue; }
      if (type !== 5) throw new Error(`未対応のShape type: ${type}`);
      const partsCount = body.readInt32LE(36), pointsCount = body.readInt32LE(40);
      const starts = Array.from({ length: partsCount }, (_, i) => body.readInt32LE(44 + i * 4));
      starts.push(pointsCount); const pointOffset = 44 + partsCount * 4, rings = [];
      for (let p = 0; p < partsCount; p++) {
        const ring = [];
        for (let i = starts[p]; i < starts[p + 1]; i++) {
          ring.push([Math.round(body.readDoubleLE(pointOffset + i * 16) * 1e6), Math.round(body.readDoubleLE(pointOffset + i * 16 + 8) * 1e6)]);
        }
        if (ring.length >= 4) rings.push(simplifyRing(ring));
      }
      yield rings;
    }
  }
}

async function write(stream, value) {
  if (stream.write(value)) return;
  await new Promise((resolve, reject) => {
    const onDrain = () => { stream.off("error", onError); resolve(); };
    const onError = (error) => { stream.off("drain", onDrain); reject(error); };
    stream.once("drain", onDrain); stream.once("error", onError);
  });
}

export async function buildBoundaries({ zip = DEFAULT_ZIP, output = DEFAULT_OUTPUT } = {}) {
  if (!existsSync(zip)) throw new Error(`N03 ZIPがありません: ${zip}`);
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "michikusa-n03-"));
  const extracted = spawnSync("unzip", ["-qq", "-j", zip, "N03-20260101.shp", "N03-20260101.dbf", "-d", temporary], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(extracted.stderr || "N03を展開できません");
  const rows = readDbf(join(temporary, "N03-20260101.dbf"));
  const streams = new Map(), reports = new Map();
  for (const [name] of SHARDS) {
    const stream = createWriteStream(join(output, `${name}.boundaries.sql`)); streams.set(name, stream);
    reports.set(name, { polygons: 0, points: 0 });
    await write(stream, "BEGIN;\nCREATE TABLE IF NOT EXISTS admin_boundaries(id INTEGER PRIMARY KEY,lg_code TEXT NOT NULL,prefecture TEXT NOT NULL,municipality TEXT NOT NULL,min_lat_e6 INTEGER NOT NULL,max_lat_e6 INTEGER NOT NULL,min_lng_e6 INTEGER NOT NULL,max_lng_e6 INTEGER NOT NULL,rings TEXT NOT NULL);\n");
  }
  let index = 0;
  for await (const rings of readShapes(join(temporary, "N03-20260101.shp"))) {
    const row = rows[index++]; if (!row || !rings.length) continue;
    const shard = PREF_TO_SHARD.get(row.N03_001); if (!shard) continue;
    const municipality = [row.N03_003, row.N03_004, row.N03_005].filter(Boolean).join("");
    const flat = rings.flat();
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lng, lat] of flat) { minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng); minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); }
    const report = reports.get(shard); report.polygons++; report.points += flat.length;
    await write(streams.get(shard), `INSERT INTO admin_boundaries VALUES(${report.polygons},${sql(row.N03_007)},${sql(row.N03_001)},${sql(municipality)},${minLat},${maxLat},${minLng},${maxLng},${sql(encodeRings(rings))});\n`);
  }
  const result = [];
  for (const [name, stream] of streams) {
    await write(stream, "CREATE INDEX IF NOT EXISTS admin_boundaries_bbox ON admin_boundaries(min_lat_e6,max_lat_e6,min_lng_e6,max_lng_e6);\nCOMMIT;\nPRAGMA optimize;\n");
    await new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve()));
    result.push({ shard: name, ...reports.get(name), bytes: (await stat(join(output, `${name}.boundaries.sql`))).size });
  }
  await rm(temporary, { recursive: true, force: true });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildBoundaries(parseArgs(process.argv)).then((reports) => reports.forEach((r) => console.log(`${r.shard}: ${r.polygons} polygons, ${r.points} simplified points, ${(r.bytes / 1048576).toFixed(1)} MiB`))).catch((error) => { console.error(error); process.exitCode = 1; });
}
