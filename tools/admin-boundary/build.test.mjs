import test from "node:test";
import assert from "node:assert/strict";
import { decodeRings, encodeRings, pointInRings, simplifyRing } from "./build.mjs";

test("行政区域の内外と穴を判定する", () => {
  const outer = [[0,0],[100,0],[100,100],[0,100],[0,0]];
  const hole = [[25,25],[25,75],[75,75],[75,25],[25,25]];
  assert.equal(pointInRings(10, 10, [outer, hole]), true);
  assert.equal(pointInRings(50, 50, [outer, hole]), false);
  assert.equal(pointInRings(150, 50, [outer, hole]), false);
});

test("直線上の余分な点を簡略化する", () => {
  const simplified = simplifyRing([[0,0],[10,0],[20,0],[20,20],[0,20],[0,0]], 1);
  assert.ok(simplified.length < 6);
  assert.deepEqual(simplified[0], simplified.at(-1));
});

test("行政区域を差分圧縮して復元する", () => {
  const rings = [[[139750000,35675000],[139751000,35675020],[139750000,35675000]]];
  const encoded = encodeRings(rings);
  assert.match(encoded, /^v1:/);
  assert.deepEqual(decodeRings(encoded), rings);
});
