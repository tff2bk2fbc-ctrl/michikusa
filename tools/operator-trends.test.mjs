import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isMapTrendEditor,
  normalizeMapTrendTerms,
  publicMapTrends,
  replaceMapTrendTerms
} from "../src/index.js";

const root = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");

test("manual map trends accept at most three complete dated terms and allow blank slots", () => {
  const good = normalizeMapTrendTerms([
    { label: "奥日光", query: "奥日光", observed_on: "2026-08-29", source_label: "Google Trends 手動確認" },
    { label: "", query: "", observed_on: "", source_label: "" }
  ]);
  assert.deepEqual(good.value, [{
    label: "奥日光", query: "奥日光", observed_on: "2026-08-29", source_label: "Google Trends 手動確認"
  }]);
  assert.equal(normalizeMapTrendTerms([
    { label: "日光", query: "日光", observed_on: "2026-02-30" }
  ]).error, "表示名・検索語・確認日を正しく入力してください");
  assert.equal(normalizeMapTrendTerms(Array.from({ length: 4 }, () => ({
    label: "日光", query: "日光", observed_on: "2026-08-29"
  }))).error, "急上昇ワードは3件までです");
});

test("public map trends expose only the three small search fields and are cacheable", async () => {
  const env = { DB: { prepare(sql) {
    assert.match(sql, /SELECT slot,label,query FROM map_trend_terms/);
    return { bind(limit) {
      assert.equal(limit, 3);
      return { all: async () => ({ results: [{ slot: 1, label: "奥日光", query: "奥日光", source_label: "internal" }] }) };
    } };
  } } };
  const response = await publicMapTrends(env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control"), /public/);
  assert.deepEqual(await response.json(), { terms: [{ slot: 1, label: "奥日光", query: "奥日光" }] });
});

test("operator authorization requires a verified Firebase UID and an active exact D1 role", async () => {
  const allowed = { DB: { prepare() { return { bind(uid) { return { first: async () =>
    uid === "owner-uid" ? { role: "trend_editor" } : null }; } }; } } };
  assert.equal(await isMapTrendEditor(allowed, { _firebase_uid: "owner-uid" }), true);
  assert.equal(await isMapTrendEditor(allowed, { _firebase_uid: "someone-else" }), false);
  assert.equal(await isMapTrendEditor(allowed, { id: "internal-user-only" }), false);
});

test("operator save atomically replaces current terms and writes only a minimal audit row", async () => {
  let savedBatch = [];
  const env = { DB: {
    prepare(sql) {
      const unbound = { sql, values: [], async run() { return { meta: { changes: 1 } }; } };
      return { bind(...values) {
        const statement = {
          sql, values,
          async run() {
            if (sql.includes("INSERT INTO app_config")) return { meta: { changes: 1 } };
            return { meta: { changes: 1 } };
          }
        };
        return statement;
      }, ...unbound };
    },
    async batch(batch) { savedBatch = batch; assert.equal(batch.length, 4); }
  } };
  const request = new Request("https://spota.test/api/admin/map-trends", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ terms: [
      { label: "奥日光", query: "奥日光", observed_on: "2026-08-29", source_label: "Google Trends 手動確認" },
      { label: "尾瀬", query: "尾瀬", observed_on: "2026-08-29", source_label: "手動確認" }
    ] })
  });
  const response = await replaceMapTrendTerms(request, env, { id: "internal-user", _firebase_uid: "owner-uid" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).terms.length, 2);
  const writes = savedBatch.filter((statement) => !statement.sql.includes("app_config"));
  assert.match(writes[0].sql, /DELETE FROM map_trend_terms/);
  assert.match(writes[1].sql, /INSERT INTO map_trend_terms/);
  assert.deepEqual(writes[1].values.slice(0, 6), [1, "奥日光", "奥日光", "Google Trends 手動確認", "2026-08-29", "owner-uid"]);
  assert.match(writes[3].sql, /INSERT INTO map_trend_audit/);
  assert.deepEqual(writes[3].values.slice(1, 4), ["owner-uid", "replace", 2]);
  assert.doesNotMatch(writes[3].sql, /label|query|source_label|observed_on/);
});

test("operator save is bounded and public reads fail closed to an empty strip", async () => {
  const limitedEnv = { DB: { prepare(sql) { return { bind() { return {
    async run() { return { meta: { changes: 0 } }; }
  }; } }; } } };
  const request = new Request("https://spota.test/api/admin/map-trends", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ terms: [] })
  });
  const rateLimited = await replaceMapTrendTerms(request, limitedEnv, { id: "internal-user", _firebase_uid: "owner-uid" });
  assert.equal(rateLimited.status, 429);

  const unavailable = await publicMapTrends({ DB: { prepare() { throw new Error("migration missing"); } } });
  assert.equal(unavailable.status, 200);
  assert.deepEqual(await unavailable.json(), { terms: [] });
});

test("public route stays before authentication while admin route is behind it and uses server-side authorization", async () => {
  const source = await read("src/index.js");
  const auth = source.indexOf("const me = await authenticate(request, env)");
  const publicRoute = source.indexOf('p === "/api/public/map-trends"');
  const adminRoute = source.indexOf('p === "/api/admin/map-trends"');
  assert.ok(publicRoute >= 0 && publicRoute < auth);
  assert.ok(adminRoute > auth);
  const adminBlock = source.slice(adminRoute, source.indexOf('if (p === "/api/wiki/search"', adminRoute));
  assert.match(adminBlock, /await isMapTrendEditor\(env, me\)/);
  assert.match(adminBlock, /return respond\(json\(\{ error: "運営者権限が必要です" \}, 403\)\)/);
  assert.match(adminBlock, /request\.method === "PUT"/);
  assert.doesNotMatch(adminBlock, /firebaseUser\.email|payload\.email|admin=true/);
});

test("map strip uses decorative SVG flames, and the editor entry is mounted only after permission succeeds", async () => {
  const html = await read("public/index.html");
  const data = await read("public/data.js");
  const sync = await read("public/sync.js");
  const operator = await read("public/operator.js");
  assert.match(html, /id="map-trend-strip"/);
  assert.ok(html.indexOf('id="map-trend-strip"') < html.indexOf('<div class="top">'));
  assert.match(data, /document\.createElementNS\(ns,'svg'\)/);
  assert.doesNotMatch(data, /🔥/);
  assert.match(data, /search\(query,true\)/);
  assert.match(sync, /id="trend-operator-entry" hidden/);
  assert.match(sync, /window\.mountTrendOperatorEntry\(s\)/);
  assert.match(operator, /response\.status===401\|\|response\.status===403/);
  assert.match(operator, /slot\.hidden=false/);
  assert.match(operator, /\/api\/admin\/map-trends/);
});
