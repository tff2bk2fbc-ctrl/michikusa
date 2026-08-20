import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(root, "..", "data", "atlas-fixture.json");

test("fixture remains aggregate-only and bounded", async () => {
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  assert.equal(fixture.mode, "fixture");
  assert.ok(Array.isArray(fixture.regions) && fixture.regions.length <= 20);
  assert.ok(Array.isArray(fixture.sources) && fixture.sources.length <= 20);
  const serialized = JSON.stringify(fixture);
  assert.ok(Buffer.byteLength(serialized, "utf8") < 16 * 1024);
  for (const forbidden of ["photoUrl", "r2Key", "exif", "latitude", "longitude", "userId", "token"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, `forbidden field: ${forbidden}`);
  }
});

test("server source keeps the UI CSP network allowlist empty", async () => {
  const source = await fs.readFile(path.join(root, "..", "server.ts"), "utf8");
  assert.match(source, /connectDomains:\s*\[\]/);
  assert.match(source, /resourceDomains:\s*\[\]/);
  assert.match(source, /frameDomains:\s*\[\]/);
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /SELECT\s+\*|DROP\s+TABLE|child_process|exec\(/i);
});

test("HTTP source is loopback and token-gated", async () => {
  const source = await fs.readFile(path.join(root, "..", "main.ts"), "utf8");
  assert.match(source, /app\.listen\(port,\s*["']127\.0\.0\.1["']/);
  assert.match(source, /loopback_only/);
  assert.match(source, /SPOTA_ATLAS_OPERATOR_TOKEN/);
  assert.match(source, /byteLength\(operatorToken/);
  assert.match(source, /operator_auth_required/);
  assert.match(source, /limit:\s*["']64kb["']/);
  assert.match(source, /request_too_large/);
  assert.match(source, /SPOTA_ATLAS_ALLOW_ORIGINLESS_HTTP/);
  assert.doesNotMatch(source, /Access-Control-Allow-Origin["']?,\s*["']\*["']/);
});
