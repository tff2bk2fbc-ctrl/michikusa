#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const OUTPUT = join(ROOT, "data/address-source");
const BASE = "https://nlftp.mlit.go.jp";
const CGI = BASE + "/cgi-bin/isj/dls";
const TERMS = BASE + "/ksj/other/agreement.html";
const DOWNLOAD_TERMS = CGI + "/_view_stipulation.cgi";

// 公式フォームが使用している都道府県選択値。先頭2桁がJIS都道府県コード。
const PREFECTURES = [
  "0003", "0207", "0260", "0307", "0376", "0426", "0467", "0550", "0643", "0693",
  "0755", "0855", "0930", "0993", "1057", "1154", "1186", "1221", "1254", "1309",
  "1407", "1468", "1551", "1653", "1711", "1768", "1815", "1890", "1971", "2017",
  "2060", "2093", "2134", "2187", "2247", "2286", "2318", "2356", "2405", "2450",
  "2549", "2584", "2629", "2693", "2717", "2755", "2841"
];

function form(entries) {
  const body = new URLSearchParams();
  for (const [key, value] of entries) body.append(key, value);
  return body;
}

async function post(path, entries) {
  const response = await fetch(CGI + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "michikusa-address-updater/1.0" },
    body: form(entries), redirect: "follow"
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response;
}

export function latestSelectionIds(html) {
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/gi) || [];
  const selected = new Map();
  for (const row of rows) {
    const id = row.match(/name="chn"[^>]*value="(\d+)"/i)?.[1] || row.match(/value="(\d+)"[^>]*name="chn"/i)?.[1];
    const kind = row.match(/name="data_kind"[^>]*value="([01])"/i)?.[1] || row.match(/value="([01])"[^>]*name="data_kind"/i)?.[1];
    if (id && kind != null && !selected.has(kind)) selected.set(kind, id);
  }
  return [selected.get("0"), selected.get("1")].filter(Boolean); // 街区、大字町丁目
}

function zipLinks(html) {
  const links = [];
  // 公式画面は通常のhrefではなく、ボタンのonclick第3引数にZIPパスを置く。
  for (const match of html.matchAll(/["']((?:https?:\/\/[^"']+|\/[^"']+)\.zip(?:\?[^"']*)?)["']/gi)) {
    links.push(new URL(match[1], BASE).href);
  }
  return [...new Set(links)];
}

async function discoverLatestIds() {
  const ids = [];
  for (let i = 0; i < PREFECTURES.length; i++) {
    const ac = PREFECTURES[i];
    const response = await post("/_choose_files.cgi", [["sbm", "2"], ["ac", ac], ["cln", "11"]]);
    const html = new TextDecoder("euc-jp").decode(await response.arrayBuffer());
    const found = latestSelectionIds(html);
    if (found.length !== 2) throw new Error(`都道府県コード${ac.slice(0, 2)}の最新2種類を特定できませんでした`);
    ids.push(...found);
    process.stdout.write(`\r最新ファイルを確認中: ${i + 1}/47`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  process.stdout.write("\n");
  return ids;
}

async function downloadFile(url, output) {
  const response = await fetch(url, { headers: { "User-Agent": "michikusa-address-updater/1.0" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const name = basename(new URL(url).pathname) || `mlit-${Date.now()}.zip`;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(`${name}: ZIPではない応答です`);
  await writeFile(join(output, name), bytes);
  console.log(`${name}: ${(bytes.length / 1024 / 1024).toFixed(2)} MiB`);
}

export async function downloadAll({ acceptTerms = false, output = OUTPUT } = {}) {
  if (!acceptTerms) {
    throw new Error([
      "国土交通省の利用約款への同意が必要です。",
      `利用規約: ${TERMS}`,
      `ダウンロード画面の約款: ${DOWNLOAD_TERMS}`,
      "内容を確認して同意する場合だけ、次を実行してください:",
      "npm run address:download -- --accept-mlit-terms"
    ].join("\n"));
  }
  await mkdir(output, { recursive: true });
  const ids = await discoverLatestIds();
  const response = await post("/_download_files.cgi", [
    ["chn", ids.join("<delimiter>")], ["sbm", "2"], ["cln", "11"]
  ]);
  const contentType = response.headers.get("content-type") || "";
  if (/zip|octet-stream/i.test(contentType)) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const disposition = response.headers.get("content-disposition") || "";
    const name = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i)?.[1] || "mlit-address-latest.zip";
    await writeFile(join(output, decodeURIComponent(name)), bytes);
    return { files: 1, ids: ids.length };
  }
  const html = new TextDecoder("euc-jp").decode(await response.arrayBuffer());
  const links = zipLinks(html);
  if (!links.length) {
    await writeFile(join(output, "download-response.html"), html);
    throw new Error("ZIPリンクを取得できませんでした。応答をdownload-response.htmlへ保存しました。");
  }
  for (const url of links) {
    await downloadFile(url, output);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { files: links.length, ids: ids.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  downloadAll({ acceptTerms: process.argv.includes("--accept-mlit-terms") })
    .then((result) => console.log(`完了: ${result.files}ファイル（街区＋大字町丁目 ${result.ids}件）`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
