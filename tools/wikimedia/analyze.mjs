#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = join(ROOT, "data/reference-source/wikimedia");
const GEO = join(SOURCE, "jawiki-latest-geo_tags.sql.gz");
const PAGE = join(SOURCE, "jawiki-latest-page.sql.gz");

function tuples(line) {
  const start = line.indexOf("VALUES ");
  if (start < 0) return [];
  const rows = [];
  let fields = [], value = "", quoted = false, escaped = false, depth = 0;
  for (let i = start + 7; i < line.length; i++) {
    const char = line[i];
    if (escaped) { value += "\\" + char; escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (char === "'") { quoted = !quoted; continue; }
    if (!quoted && char === "(") { depth = 1; fields = []; value = ""; continue; }
    if (!quoted && depth && char === ",") { fields.push(value); value = ""; continue; }
    if (!quoted && depth && char === ")") {
      fields.push(value); rows.push(fields); depth = 0; value = ""; continue;
    }
    if (depth) value += char;
  }
  return rows;
}

export function mysqlText(value) {
  return String(value || "")
    .replaceAll("\\'", "'").replaceAll('\\"', '"')
    .replaceAll("\\n", "\n").replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t").replaceAll("\\\\", "\\")
    .replaceAll("_", " ");
}

export async function eachInsert(path, table, callback) {
  const input = createReadStream(path).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  const prefix = `INSERT INTO \`${table}\` VALUES `;
  for await (const line of lines) {
    if (!line.startsWith(prefix)) continue;
    for (const row of tuples(line)) callback(row);
  }
}

export async function analyze() {
  const coordinates = new Map();
  let geoRows = 0, primaryEarth = 0, japanBounds = 0;
  await eachInsert(GEO, "geo_tags", (row) => {
    geoRows++;
    if (row[2] !== "earth" || row[3] !== "1") return;
    primaryEarth++;
    const lat = Number(row[4]), lng = Number(row[5]);
    // 南鳥島・沖ノ鳥島を含む日本の概略外接矩形。最終投入時は行政区域面で再判定する。
    if (!(lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154)) return;
    japanBounds++;
    if (!coordinates.has(Number(row[1]))) coordinates.set(Number(row[1]), { lat, lng, type: row[7] === "NULL" ? "" : mysqlText(row[7]) });
  });

  let pageRows = 0, articles = 0, matched = 0, redirects = 0, titleBytes = 0;
  const examples = [];
  await eachInsert(PAGE, "page", (row) => {
    pageRows++;
    if (row[1] !== "0") return;
    articles++;
    const coordinate = coordinates.get(Number(row[0]));
    if (!coordinate) return;
    if (row[3] === "1") { redirects++; return; }
    const title = mysqlText(row[2]);
    matched++; titleBytes += Buffer.byteLength(title);
    if (examples.length < 12) examples.push({ id: Number(row[0]), title, ...coordinate });
  });

  // D1は整数座標、記事ID、短い種別、タイトル、格子索引を保持する想定。
  const estimatedPayload = matched * (8 + 4 + 4 + 4 + 8 + 8) + titleBytes;
  return {
    files: { geo_bytes: (await stat(GEO)).size, page_bytes: (await stat(PAGE)).size },
    geo_rows: geoRows, primary_earth: primaryEarth, japan_bbox_primary: japanBounds,
    unique_candidate_pages: coordinates.size, page_rows: pageRows, namespace0_articles: articles,
    matched_nonredirect_articles: matched, matched_redirects_excluded: redirects,
    title_utf8_bytes: titleBytes, estimated_d1_payload_bytes_before_indexes: estimatedPayload,
    examples
  };
}

export async function loadCandidates() {
  const candidates = new Map();
  await eachInsert(GEO, "geo_tags", (row) => {
    if (row[2] !== "earth" || row[3] !== "1") return;
    const lat = Number(row[4]), lng = Number(row[5]), pageId = Number(row[1]);
    if (lat < 20 || lat > 46 || lng < 122 || lng > 154 || candidates.has(pageId)) return;
    candidates.set(pageId, { pageId, lat, lng, type: row[7] === "NULL" ? "" : mysqlText(row[7]) });
  });
  await eachInsert(PAGE, "page", (row) => {
    const candidate = candidates.get(Number(row[0]));
    if (!candidate) return;
    if (row[1] !== "0" || row[3] === "1") candidates.delete(Number(row[0]));
    else candidate.title = mysqlText(row[2]);
  });
  for (const [id, candidate] of candidates) if (!candidate.title) candidates.delete(id);
  return candidates;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  analyze().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error); process.exitCode = 1;
  });
}
