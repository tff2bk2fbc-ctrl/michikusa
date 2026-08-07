import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build, mapHeader, parseCsvLine } from "./build.mjs";
import { latestSelectionIds } from "./download.mjs";
import { normalizeTown } from "./enrich-abr.mjs";

test("quoted CSVを解析する", () => {
  assert.deepEqual(parseCsvLine('"東京都","千代田区","霞が関","","1"'), ["東京都", "千代田区", "霞が関", "", "1"]);
  assert.deepEqual(parseCsvLine('"a""b",c'), ['a"b', "c"]);
});

test("国交省の日本語ヘッダーを認識する", () => {
  const m = mapHeader(["都道府県名", "市区町村名", "大字・丁目名", "小字・通称名", "街区符号・地番", "座標系番号", "Ｘ座標", "Ｙ座標", "緯度", "経度", "住居表示フラグ", "代表フラグ", "更新前履歴フラグ", "更新後履歴フラグ"]);
  assert.equal(m.lat, 8); assert.equal(m.lng, 9); assert.equal(m.current, 13);
});

test("大字町丁目の異なる列構成を認識する", () => {
  const m = mapHeader(["都道府県コード", "都道府県名", "市区町村コード", "市区町村名", "大字町丁目コード", "大字町丁目名", "緯度", "経度", "原典資料コード", "大字・字・丁目区分コード"]);
  assert.equal(m.pref, 1); assert.equal(m.municipality, 3); assert.equal(m.town, 5);
  assert.equal(m.lat, 6); assert.equal(m.lng, 7);
  assert.equal(m.locality, -1); assert.equal(m.block, -1);
});

test("一覧から最新の街区・大字町丁目IDだけを選ぶ", () => {
  const html = '<tr><input value="25151" name="chn"><input value="0" name="data_kind"></tr>' +
    '<tr><input value="25150" name="chn"><input value="1" name="data_kind"></tr>' +
    '<tr><input value="old" name="chn"><input value="0" name="data_kind"></tr>';
  assert.deepEqual(latestSelectionIds(html), ["25151", "25150"]);
});

test("町字の全角数字と丁目表記を正規化する", () => {
  assert.equal(normalizeTown("旭ヶ丘１２丁目"), "旭ケ丘十二丁目");
});

test("代表点だけを地域別SQLへ変換する", async () => {
  const base = await mkdtemp(join(tmpdir(), "address-build-test-"));
  const input = join(base, "input"), output = join(base, "output");
  await mkdir(input);
  const csv = [
    "都道府県名,市区町村名,大字・丁目名,小字・通称名,街区符号・地番,座標系番号,Ｘ座標,Ｙ座標,緯度,経度,住居表示フラグ,代表フラグ,更新前履歴フラグ,更新後履歴フラグ",
    "東京都,千代田区,霞が関,,1,9,0,0,35.675000,139.750000,1,1,0,0",
    "東京都,千代田区,霞が関,,2,9,0,0,35.675100,139.750100,1,0,0,0"
  ].join("\n");
  // ASCIIだけのfixtureはShift_JISとしても同じ。日本語部分だけTextDecoder確認用にShift_JIS化が必要なためiconvを使う。
  const utf8 = join(base, "fixture-utf8.csv"), sjis = join(input, "fixture.csv");
  await writeFile(utf8, csv);
  const { spawnSync } = await import("node:child_process");
  const converted = spawnSync("iconv", ["-f", "UTF-8", "-t", "SHIFT_JIS", utf8], { encoding: null });
  assert.equal(converted.status, 0);
  await writeFile(sjis, converted.stdout);
  const result = await build({ input, output });
  assert.equal(result.shards.length, 1);
  assert.equal(result.shards[0].shard, "tokyo");
  assert.equal(result.shards[0].points, 1);
  const sql = await readFile(join(output, "tokyo.sql"), "utf8");
  assert.match(sql, /address_prefectures VALUES\(1,'東京都'\)/);
  assert.match(sql, /35675000,139750000/);
  const db = join(base, "tokyo.sqlite3");
  const loaded = spawnSync("sqlite3", [db], { input: sql, encoding: "utf8" });
  assert.equal(loaded.status, 0, loaded.stderr);
  const queried = spawnSync("sqlite3", [db, "SELECT pr.name||mu.name||t.name||ap.block FROM address_points ap JOIN address_towns t ON t.id=ap.town_id JOIN address_municipalities mu ON mu.id=t.municipality_id JOIN address_prefectures pr ON pr.id=mu.prefecture_id WHERE grid_lat=17837 AND grid_lng=69875;"], { encoding: "utf8" });
  assert.equal(queried.stdout.trim(), "東京都千代田区霞が関1");
});
