import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker from "../src/index.js";
import {
  MAX_MAP_PLACE_BOUNDS_DEGREES,
  MAX_MAP_PLACE_RESULTS,
  queryOpenMapPlaces,
  selectMapAddressDatabases
} from "../src/lib/map-places.js";

const root = new URL("../", import.meta.url);

function regionalDatabase({ nearby = [], wikipedia = [], failWikipedia = false } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return { bind(...values) {
        calls.push({ sql, values });
        return { async all() {
          if (sql.includes("wikipedia_places")) {
            if (failWikipedia) throw new Error("table not deployed");
            return { results: wikipedia };
          }
          if (sql.includes("nearby_places")) return { results: nearby };
          throw new Error("unexpected regional SQL");
        } };
      } };
    }
  };
}

function rateDatabase() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      return { bind() { return { async run() { return { meta: { changes: 1 } }; } }; } };
    }
  };
}

function mapRequest(body, method = "POST") {
  return new Request("https://spota.test/api/map/places", {
    method,
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.20" },
    body: method === "POST" ? JSON.stringify(body) : undefined
  });
}

test("map shard selection is bounded to viewport-intersecting configured databases", () => {
  const hokkaido = {}, tokyo = {}, kyushu = {};
  const env = { ADDR_HOKKAIDO: hokkaido, ADDR_TOKYO: tokyo, ADDR_KYUSHU_OKINAWA: kyushu };
  assert.deepEqual(
    selectMapAddressDatabases(env, { s: 43.0, w: 141.0, n: 43.1, e: 141.1 }).map((entry) => entry.binding),
    ["ADDR_HOKKAIDO"]
  );
  assert.deepEqual(
    selectMapAddressDatabases(env, { s: 35.65, w: 139.70, n: 35.72, e: 139.80 }).map((entry) => entry.binding),
    ["ADDR_TOKYO"]
  );
  assert.deepEqual(
    selectMapAddressDatabases(env, { s: 26.1, w: 127.6, n: 26.3, e: 127.9 }).map((entry) => entry.binding),
    ["ADDR_KYUSHU_OKINAWA"]
  );
});

test("open map query returns only allowlisted derived rows with stable source identity", async () => {
  const db = regionalDatabase({
    nearby: [{ id: "station-1", kind: "station", name: "試験駅", detail: "試験線",
      lat_e6: 35681000, lng_e6: 139767000, source: "mlit-n02" },
    { id: "unknown-1", kind: "facility", name: "由来不明地点", detail: "MUS",
      lat_e6: 35681500, lng_e6: 139767500, source: "unknown-provider" }],
    wikipedia: [{ page_id: 42, title: "試験庭園", type: "landmark",
      lat_e6: 35682000, lng_e6: 139768000 }]
  });
  const result = await queryOpenMapPlaces({ ADDR_TOKYO: db },
    { s: 35.67, w: 139.75, n: 35.70, e: 139.79 }, 200);
  assert.equal(result.places.length, 2);
  assert.deepEqual(result.places.map((place) => place.id), ["mlit-n02:station:station-1", "jawiki:42"]);
  assert.deepEqual(result.places.map((place) => place.category), ["駅", "園"]);
  assert.equal(result.places[0].sources[0].provider, "国土交通省 国土数値情報 N02");
  assert.equal(result.places[1].sources[0].provider, "Wikipedia");
  assert.match(result.places[1].sources[0].url, /^https:\/\/ja\.wikipedia\.org\/wiki\//);
  assert.equal(db.calls.length, 2);
  for (const call of db.calls) {
    assert.match(call.sql, /grid_lat BETWEEN \? AND \?/);
    assert.match(call.sql, /lat_e6 BETWEEN \? AND \?/);
    assert.match(call.sql, /LIMIT \?/);
    assert.ok(call.values.at(-1) <= MAX_MAP_PLACE_RESULTS);
  }
  assert.match(db.calls.find((call) => call.sql.includes("nearby_places")).sql,
    /source IN \('mlit-n02','geonames'\)/);
});

test("a missing staged Wikipedia table fails source-locally without hiding other open data", async () => {
  const db = regionalDatabase({
    nearby: [{ id: "nature-1", kind: "nature", name: "試験山", detail: "MT",
      lat_e6: 35681000, lng_e6: 139767000, source: "geonames" }],
    failWikipedia: true
  });
  const result = await queryOpenMapPlaces({ ADDR_TOKYO: db },
    { s: 35.67, w: 139.75, n: 35.70, e: 139.79 }, 20);
  assert.equal(result.places.length, 1);
  assert.equal(result.places[0].id, "geonames:nature:nature-1");
});

test("public map API is POST-only, bounded, capped, and never reads legacy DB places", async () => {
  const db = regionalDatabase({ wikipedia: [{ page_id: 7, title: "公開地点", type: "landmark",
    lat_e6: 35681000, lng_e6: 139767000 }] });
  const rate = rateDatabase();
  let clientBurst = 0, globalBurst = 0;
  const env = {
    DB: rate,
    ADDR_TOKYO: db,
    MAP_PLACES_RATE_LIMITER: { async limit() { clientBurst += 1; return { success: true }; } },
    MAP_PLACES_GLOBAL_RATE_LIMITER: { async limit() { globalBurst += 1; return { success: true }; } }
  };

  const method = await worker.fetch(mapRequest({}, "GET"), env);
  assert.equal(method.status, 405);

  const oversized = await worker.fetch(mapRequest({ s: 35, w: 139, n: 35 + MAX_MAP_PLACE_BOUNDS_DEGREES + 0.01, e: 139.1 }), env);
  assert.equal(oversized.status, 400);

  const response = await worker.fetch(mapRequest({ s: 35.67, w: 139.75, n: 35.70, e: 139.79, limit: 9999 }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const payload = await response.json();
  assert.equal(payload.count, 1);
  assert.equal(payload.places[0].id, "jawiki:7");
  assert.ok(payload.attributions.some((entry) => entry.provider === "Wikipedia"));
  assert.ok(db.calls.every((call) => call.values.at(-1) <= MAX_MAP_PLACE_RESULTS));
  assert.ok(rate.calls.every((sql) => !/FROM places/i.test(sql)));
  assert.equal(clientBurst, 1);
  assert.equal(globalBurst, 1);
});

test("map API fails closed before D1 when either required burst limiter is missing", async () => {
  const db = regionalDatabase();
  const rate = rateDatabase();
  const body = { s: 35.67, w: 139.75, n: 35.70, e: 139.79 };

  const missingClient = await worker.fetch(mapRequest(body), {
    DB: rate, ADDR_TOKYO: db,
    MAP_PLACES_GLOBAL_RATE_LIMITER: { limit: async () => ({ success: true }) }
  });
  assert.equal(missingClient.status, 429);

  const missingGlobal = await worker.fetch(mapRequest(body), {
    DB: rate, ADDR_TOKYO: db,
    MAP_PLACES_RATE_LIMITER: { limit: async () => ({ success: true }) }
  });
  assert.equal(missingGlobal.status, 429);
  assert.equal(rate.calls.length, 0);
  assert.equal(db.calls.length, 0);
});

test("client loads the open-data route with stable dedupe and hard memory caps", async () => {
  const source = await readFile(new URL("public/data.js", root), "utf8");
  assert.match(source, /SERVER\+'\/api\/map\/places'/);
  assert.doesNotMatch(source, /SERVER\+'\/api\/places'/);
  assert.match(source, /MAX_MAP_DATA_CELLS=48,MAX_MAP_DATA_POIS=1200/);
  assert.match(source, /if\(p&&p\.id\)return 'id:'/);
  assert.match(source, /Number\(p&&p\.lat\)\.toFixed\(4\)\+','\+Number\(p&&p\.lng\)\.toFixed\(4\)/);
  assert.doesNotMatch(source, /drive\.google\.com|storage\.googleapis\.com/);
});

test("map attribution discloses every newly connected open-data provider and license", async () => {
  const source = await readFile(new URL("public/map.js", root), "utf8");
  assert.match(source, /国土交通省 国土数値情報・位置参照情報（加工）/);
  assert.match(source, /GeoNames, CC BY 4\.0/);
  assert.match(source, /Wikipedia contributors（CC BY-SA 4\.0）/);
  assert.match(source, /target="_blank" rel="noopener noreferrer"/);
});

test("wrangler declares client/global map burst limits and cleanup removes expired counters", async () => {
  const wrangler = JSON.parse(await readFile(new URL("wrangler.jsonc", root), "utf8"));
  const limits = new Map((wrangler.ratelimits || []).map((entry) => [entry.name, entry.simple]));
  assert.deepEqual(limits.get("MAP_PLACES_RATE_LIMITER"), { limit: 60, period: 60 });
  assert.deepEqual(limits.get("MAP_PLACES_GLOBAL_RATE_LIMITER"), { limit: 2000, period: 60 });
  const workerSource = await readFile(new URL("src/index.js", root), "utf8");
  assert.match(workerSource, /requiredBurstLimit\(env, "MAP_PLACES_RATE_LIMITER", client\)/);
  assert.match(workerSource, /requiredBurstLimit\(env, "MAP_PLACES_GLOBAL_RATE_LIMITER", "map-places-global"\)/);
  assert.match(workerSource, /DELETE FROM app_config WHERE k LIKE 'map_places_global_day_%'/);
});
