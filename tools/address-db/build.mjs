#!/usr/bin/env node
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DEFAULT_INPUT = join(ROOT, "data/address-source");
const DEFAULT_OUTPUT = join(ROOT, "generated/address-db");
const GRID_SCALE = 500; // 0.002 degrees

export const SHARDS = [
  ["hokkaido", ["北海道"]],
  ["tohoku", ["青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県"]],
  ["tokyo", ["東京都"]],
  ["south_kanto", ["神奈川県", "千葉県"]],
  ["north_kanto", ["埼玉県", "茨城県", "栃木県", "群馬県"]],
  ["chubu", ["新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県"]],
  ["kinki", ["三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県"]],
  ["chugoku_shikoku", ["鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県"]],
  ["kyushu_okinawa", ["福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"]]
];

const PREF_TO_SHARD = new Map(SHARDS.flatMap(([shard, prefs]) => prefs.map((p) => [p, shard])));

function parseArgs(argv) {
  const out = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--input") out.input = resolve(argv[++i]);
    else if (argv[i] === "--output") out.output = resolve(argv[++i]);
    else if (argv[i] === "--help") out.help = true;
    else throw new Error(`不明なオプション: ${argv[i]}`);
  }
  return out;
}

export function parseCsvLine(line) {
  const fields = [];
  let value = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (c === "," && !quoted) {
      fields.push(value); value = "";
    } else value += c;
  }
  fields.push(value.replace(/\r$/, ""));
  return fields;
}

function sql(value) {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function fieldIndex(header, names, fallback = -1) {
  for (const name of names) {
    const i = header.findIndex((v) => v.replace(/^\uFEFF/, "").trim() === name);
    if (i >= 0) return i;
  }
  return fallback;
}

export function mapHeader(header) {
  return {
    pref: fieldIndex(header, ["都道府県名"], 0),
    municipality: fieldIndex(header, ["市区町村名"], 1),
    town: fieldIndex(header, ["大字・丁目名", "大字町丁目名"], 2),
    locality: fieldIndex(header, ["小字・通称名"]),
    block: fieldIndex(header, ["街区符号・地番", "街区符号", "地番"]),
    lat: fieldIndex(header, ["緯度"], 8),
    lng: fieldIndex(header, ["経度"], 9),
    representative: fieldIndex(header, ["代表フラグ"]),
    current: fieldIndex(header, ["更新後履歴フラグ", "今年度対応内容"])
  };
}

async function* decodedLines(path) {
  const decoder = new TextDecoder("shift_jis");
  let pending = "";
  for await (const chunk of createReadStream(path)) {
    pending += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = pending.indexOf("\n")) >= 0) {
      yield pending.slice(0, at);
      pending = pending.slice(at + 1);
    }
  }
  pending += decoder.decode();
  if (pending) yield pending;
}

async function collectFiles(path, extension, into = []) {
  if (!existsSync(path)) return into;
  const s = await stat(path);
  if (s.isFile()) {
    if (extname(path).toLowerCase() === extension) into.push(path);
    return into;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    await collectFiles(join(path, entry.name), extension, into);
  }
  return into;
}

async function prepareSources(input) {
  const csv = await collectFiles(input, ".csv");
  const zips = await collectFiles(input, ".zip");
  if (!zips.length) return { csv, cleanup: async () => {} };
  const temp = await mkdtemp(join(tmpdir(), "michikusa-address-"));
  for (const zip of zips) {
    const target = join(temp, basename(zip, extname(zip)));
    await mkdir(target, { recursive: true });
    const result = spawnSync("unzip", ["-qq", "-o", zip, "-d", target], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`ZIPを展開できません: ${zip}\n${result.stderr}`);
  }
  return { csv: csv.concat(await collectFiles(temp, ".csv")), cleanup: () => rm(temp, { recursive: true, force: true }) };
}

function createShard(name, output) {
  const work = join(output, ".work");
  return {
    name,
    pointPath: join(work, `${name}.points.sql`),
    points: 0,
    skipped: 0,
    prefIds: new Map(), municipalityIds: new Map(), townIds: new Map(),
    pointStream: null
  };
}

function intern(map, key) {
  let id = map.get(key);
  if (!id) { id = map.size + 1; map.set(key, id); }
  return id;
}

async function writeChunk(stream, text) {
  if (stream.write(text)) return;
  await new Promise((resolve, reject) => {
    const onDrain = () => { stream.off("error", onError); resolve(); };
    const onError = (error) => { stream.off("drain", onDrain); reject(error); };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function entriesById(map) {
  return [...map.entries()].sort((a, b) => a[1] - b[1]);
}

async function finishShard(shard, output, schema) {
  await new Promise((resolve, reject) => shard.pointStream.end((e) => e ? reject(e) : resolve()));
  if (!shard.points) { await rm(shard.pointPath, { force: true }); return null; }
  const target = join(output, `${shard.name}.sql`);
  const out = createWriteStream(target);
  await writeChunk(out, "BEGIN TRANSACTION;\n" + schema.replace(/CREATE INDEX[\s\S]*?;\n?/g, "") + "\n");
  await writeChunk(out, `INSERT INTO address_meta VALUES ('dataset','MLIT location reference information'),('generated_at',${sql(new Date().toISOString())}),('grid_scale','${GRID_SCALE}');\n`);
  for (const [name, id] of entriesById(shard.prefIds)) await writeChunk(out, `INSERT INTO address_prefectures VALUES(${id},${sql(name)});\n`);
  for (const [key, id] of entriesById(shard.municipalityIds)) {
    const [prefId, name] = key.split("\u0000");
    await writeChunk(out, `INSERT INTO address_municipalities VALUES(${id},${prefId},${sql(name)});\n`);
  }
  for (const [key, id] of entriesById(shard.townIds)) {
    const [municipalityId, name, locality] = key.split("\u0000");
    await writeChunk(out, `INSERT INTO address_towns VALUES(${id},${municipalityId},${sql(name)},${sql(locality)});\n`);
  }
  await new Promise((resolve, reject) => {
    const input = createReadStream(shard.pointPath);
    input.on("error", reject); out.on("error", reject);
    input.on("end", resolve); input.pipe(out, { end: false });
  });
  await writeChunk(out, "CREATE INDEX address_points_grid ON address_points(grid_lat,grid_lng);\nCOMMIT;\nPRAGMA optimize;\n");
  await new Promise((resolve, reject) => out.end((e) => e ? reject(e) : resolve()));
  await rm(shard.pointPath, { force: true });
  return { shard: shard.name, points: shard.points, skipped: shard.skipped, sql: basename(target), bytes: (await stat(target)).size };
}

export async function build({ input = DEFAULT_INPUT, output = DEFAULT_OUTPUT } = {}) {
  await mkdir(input, { recursive: true });
  await rm(output, { recursive: true, force: true });
  await mkdir(join(output, ".work"), { recursive: true });
  const sources = await prepareSources(input);
  if (!sources.csv.length) {
    await sources.cleanup();
    throw new Error(`CSVまたはZIPがありません。国交省データを ${input} に置いてください。`);
  }
  const shards = new Map(SHARDS.map(([name]) => [name, createShard(name, output)]));
  for (const shard of shards.values()) shard.pointStream = createWriteStream(shard.pointPath);
  try {
    // MLIT配布物は通常1ファイル1地域。ファイルを跨いでも辞書IDは各shard内で共有する。
    for (const path of sources.csv) await ingestCsvBuffered(path, shards);
    const schema = await readFile(join(HERE, "schema.sql"), "utf8");
    const reports = [];
    for (const shard of shards.values()) {
      const report = await finishShard(shard, output, schema);
      if (report) reports.push(report);
    }
    const summary = { generatedAt: new Date().toISOString(), inputFiles: sources.csv.length, gridScale: GRID_SCALE, shards: reports };
    await writeFile(join(output, "manifest.json"), JSON.stringify(summary, null, 2) + "\n");
    await rm(join(output, ".work"), { recursive: true, force: true });
    return summary;
  } finally {
    await sources.cleanup();
  }
}

async function ingestCsvBuffered(path, shards) {
  let columns = null;
  const batches = new Map();
  const flush = async (shard) => {
    const batch = batches.get(shard.name) || [];
    if (!batch.length) return;
    await writeChunk(shard.pointStream, `INSERT INTO address_points VALUES\n${batch.join(",\n")};\n`);
    batches.set(shard.name, []);
  };
  for await (const raw of decodedLines(path)) {
    if (!raw.trim()) continue;
    const row = parseCsvLine(raw);
    if (!columns || row[0].replace(/^\uFEFF/, "").trim() === "都道府県名") { columns = mapHeader(row); continue; }
    const pref = String(row[columns.pref] || "").trim();
    const shard = shards.get(PREF_TO_SHARD.get(pref));
    if (!shard) continue;
    if (columns.representative >= 0 && row[columns.representative] && row[columns.representative] !== "1") { shard.skipped++; continue; }
    if (columns.current >= 0 && row[columns.current] === "3") { shard.skipped++; continue; }
    const lat = Number(row[columns.lat]), lng = Number(row[columns.lng]);
    const municipality = String(row[columns.municipality] || "").trim();
    const town = String(row[columns.town] || "").trim();
    if (!(lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154) || !municipality || !town) { shard.skipped++; continue; }
    const prefId = intern(shard.prefIds, pref);
    const municipalityId = intern(shard.municipalityIds, `${prefId}\u0000${municipality}`);
    const locality = columns.locality >= 0 ? String(row[columns.locality] || "").trim() : "";
    const townId = intern(shard.townIds, `${municipalityId}\u0000${town}\u0000${locality}`);
    const latE6 = Math.round(lat * 1e6), lngE6 = Math.round(lng * 1e6);
    const block = columns.block >= 0 ? String(row[columns.block] || "").trim() : "";
    const batch = batches.get(shard.name) || [];
    batch.push(`(${++shard.points},${townId},${sql(block)},${latE6},${lngE6},${Math.floor(lat * GRID_SCALE)},${Math.floor(lng * GRID_SCALE)})`);
    batches.set(shard.name, batch);
    if (batch.length >= 200) await flush(shard);
  }
  for (const [name, batch] of batches) if (batch.length) await flush(shards.get(name));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log("Usage: npm run address:build -- [--input DIR_OR_FILE] [--output DIR]");
  } else {
    build(options).then((summary) => {
      for (const s of summary.shards) console.log(`${s.shard}: ${s.points.toLocaleString()} points, ${(s.bytes / 1024 / 1024).toFixed(1)} MiB SQL`);
    }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
