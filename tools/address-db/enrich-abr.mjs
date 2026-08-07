#!/usr/bin/env node
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCsvLine, SHARDS } from "./build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DEFAULT_ZIP = join(ROOT, "data/reference-source/digital-agency-abr/mt_town_all.csv.zip");
const DEFAULT_DB_DIR = join(ROOT, "generated/address-db");
const PREF_TO_SHARD = new Map(SHARDS.flatMap(([shard, prefs]) => prefs.map((pref) => [pref, shard])));
const KANJI_DIGITS = ["〇","一","二","三","四","五","六","七","八","九"];

function sql(value) { return `'${String(value ?? "").replaceAll("'", "''")}'`; }

export function normalizeTown(value) {
  return String(value || "").normalize("NFKC").replace(/[ヶケ]/g, "ケ").replace(/[0-9]+(?=丁目)/g, (raw) => {
    const n = Number(raw); if (n < 10) return KANJI_DIGITS[n];
    if (n < 20) return `十${n % 10 ? KANJI_DIGITS[n % 10] : ""}`;
    if (n < 100) return `${KANJI_DIGITS[Math.floor(n / 10)]}十${n % 10 ? KANJI_DIGITS[n % 10] : ""}`;
    return raw;
  }).replace(/[\s　]/g, "");
}

function municipalityName(row, at) {
  return [row[at.county], row[at.city], row[at.ward]].filter(Boolean).join("");
}

function mapHeader(header) {
  const index = (name) => header.indexOf(name);
  return Object.fromEntries(["lg_code","machiaza_id","pref","county","city","ward","oaza_cho","chome","koaza","status_flg","post_code"].map((name) => [name, index(name)]));
}

function existingTowns(db) {
  const query = `SELECT t.id,pr.name,mu.name,t.name,t.locality FROM address_towns t JOIN address_municipalities mu ON mu.id=t.municipality_id JOIN address_prefectures pr ON pr.id=mu.prefecture_id;`;
  const result = spawnSync("sqlite3", ["-separator", "\u001f", db, query], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `${db}を読めません`);
  const map = new Map();
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const [id, pref, municipality, town, locality] = line.split("\u001f");
    const keys = [normalizeTown(town), normalizeTown(town + locality)];
    for (const key of keys) map.set(`${pref}\0${municipality}\0${key}`, Number(id));
  }
  return map;
}

async function write(stream, text) {
  if (stream.write(text)) return;
  await new Promise((resolve, reject) => {
    const onDrain = () => { stream.off("error", onError); resolve(); };
    const onError = (error) => { stream.off("drain", onDrain); reject(error); };
    stream.once("drain", onDrain); stream.once("error", onError);
  });
}

export async function enrichAbr({ zip = DEFAULT_ZIP, dbDir = DEFAULT_DB_DIR } = {}) {
  if (!existsSync(zip)) throw new Error(`全国町字マスターがありません: ${zip}`);
  await mkdir(dbDir, { recursive: true });
  const shards = new Map();
  for (const [name] of SHARDS) {
    const db = join(dbDir, `${name}.sqlite3`); if (!existsSync(db)) continue;
    const stream = createWriteStream(join(dbDir, `${name}.abr.sql`));
    await write(stream, "BEGIN;\nCREATE TABLE IF NOT EXISTS address_town_registry(town_id INTEGER PRIMARY KEY,lg_code TEXT NOT NULL,machiaza_id TEXT NOT NULL,official_name TEXT NOT NULL,post_code TEXT NOT NULL DEFAULT '',status_flg TEXT NOT NULL DEFAULT '');\n");
    shards.set(name, { map: existingTowns(db), stream, matched: new Set(), rows: 0 });
  }
  const child = spawn("unzip", ["-p", zip, "mt_town_all.csv"], { stdio: ["ignore", "pipe", "inherit"] });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let at = null;
  for await (const line of lines) {
    const row = parseCsvLine(line);
    if (!at) { at = mapHeader(row); continue; }
    const pref = row[at.pref], shard = shards.get(PREF_TO_SHARD.get(pref)); if (!shard) continue;
    const municipality = municipalityName(row, at);
    const official = [row[at.oaza_cho], row[at.chome], row[at.koaza]].filter(Boolean).join("");
    const key = `${pref}\0${municipality}\0${normalizeTown(official)}`;
    const townId = shard.map.get(key); if (!townId || shard.matched.has(townId)) continue;
    shard.matched.add(townId); shard.rows++;
    const postCode = String(row[at.post_code] || "").replace(/\D/g, "").slice(0, 7);
    await write(shard.stream, `INSERT OR REPLACE INTO address_town_registry VALUES(${townId},${sql(String(row[at.lg_code] || "").slice(0,5))},${sql(row[at.machiaza_id])},${sql(official)},${sql(postCode)},${sql(row[at.status_flg])});\n`);
  }
  const exit = await closed;
  if (exit !== 0) throw new Error(`全国町字マスターを展開できません: ${exit}`);
  const reports = [];
  for (const [name, shard] of shards) {
    await write(shard.stream, "COMMIT;\nPRAGMA optimize;\n");
    await new Promise((resolve, reject) => shard.stream.end((error) => error ? reject(error) : resolve()));
    const path = join(dbDir, `${name}.abr.sql`);
    reports.push({ shard: name, matched: shard.rows, totalTowns: shard.map.size, bytes: (await stat(path)).size });
  }
  return reports;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  enrichAbr().then((reports) => reports.forEach((r) => console.log(`${r.shard}: ${r.matched} matched, ${(r.bytes / 1048576).toFixed(1)} MiB`))).catch((error) => { console.error(error); process.exitCode = 1; });
}
