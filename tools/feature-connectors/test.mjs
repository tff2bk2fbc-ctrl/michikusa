import assert from "node:assert/strict";
import {
  assertConnectable,
  canConnect,
  enabledOfflineConnectors,
  getConnector,
  listConnectors,
  publicConnectionSummary
} from "./index.mjs";

const all = listConnectors();
assert.ok(all.length >= 10, "connector registry should cover the planned services");
assert.equal(getConnector("does-not-exist"), null);

assert.equal(canConnect("osm-derived-index"), true);
assert.equal(canConnect("google-drive-raw-backup"), true);
assert.equal(canConnect("serpapi"), false);
assert.equal(canConnect("serpapi", { allowLive: true, approved: true }), false);
assert.equal(canConnect("cloudflare-map-api", { allowLive: true, approved: true }), true);

assert.throws(
  () => assertConnectable("tiktok-cross-user-trends", { allowLive: true, approved: true }),
  (error) => error?.code === "CONNECTOR_NOT_APPROVED"
);
assert.equal(enabledOfflineConnectors().some(({ id }) => id === "osm-derived-index"), true);

const summary = publicConnectionSummary();
assert.equal(summary.some((entry) => "secret" in entry), false);
assert.equal(summary.some((entry) => entry.id === "google-trends-alpha" && entry.mode === "disabled"), true);

console.log("feature connector tests: 7/7 passed");
