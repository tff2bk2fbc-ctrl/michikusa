import assert from "node:assert/strict";
import { fetchWikipediaPlaceSearch, WikipediaApiError } from "../../src/lib/wikipedia.js";

function fakeResponse(payload, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return headers[name] || headers[name.toLowerCase()] || ""; } },
    async text() { return typeof payload === "string" ? payload : JSON.stringify(payload); }
  };
}

let seenRequest;
const result = await fetchWikipediaPlaceSearch("上野公園", {
  limit: 5,
  fetchImpl: async (request, init) => {
    seenRequest = { request: String(request), init };
    return fakeResponse({ query: { pages: [
      { pageid: 123, title: "上野公園", coordinates: [{ lat: 35.715, lon: 139.773 }] },
      { pageid: 456, title: "座標なし", coordinates: [] }
    ] } });
  }
});
assert.equal(result.results[0].coordinates.lat, 35.715);
assert.equal(result.results[0].coordinates.lng, 139.773);
assert.equal(result.results[1].coordinates, null);
assert.match(seenRequest.request, /w\/api\.php/);
assert.equal(seenRequest.init.redirect, "error");
assert.equal(seenRequest.init.headers["User-Agent"].startsWith("Spota/1.0"), true);
assert.match(seenRequest.request, /maxlag=5/);

await assert.rejects(
  () => fetchWikipediaPlaceSearch("\u0000", { fetchImpl: async () => fakeResponse({}) }),
  (error) => error instanceof WikipediaApiError && error.code === "invalid_query"
);
await assert.rejects(
  () => fetchWikipediaPlaceSearch("東京", { fetchImpl: async () => fakeResponse({}, { status: 429, headers: { "Retry-After": "3" } }) }),
  (error) => error instanceof WikipediaApiError && error.code === "rate_limited" && error.retryAfter === "3"
);
await assert.rejects(
  () => fetchWikipediaPlaceSearch("東京", { fetchImpl: async () => fakeResponse("x", { headers: { "Content-Length": "70000" } }) }),
  (error) => error instanceof WikipediaApiError && error.code === "response_too_large"
);

await assert.rejects(
  () => fetchWikipediaPlaceSearch("東京", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get() { return ""; } },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(65 * 1024));
          controller.close();
        }
      }),
      async text() { throw new Error("stream must be used"); }
    })
  }),
  (error) => error instanceof WikipediaApiError && error.code === "response_too_large"
);

await assert.rejects(
  () => fetchWikipediaPlaceSearch("東京", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get() { return ""; } },
      body: null,
      async text() { return "x".repeat(65 * 1024); }
    })
  }),
  (error) => error instanceof WikipediaApiError && error.code === "response_too_large"
);

console.log("wikipedia api tests: 8/8 passed");
