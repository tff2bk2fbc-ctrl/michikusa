import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import worker, { friendRequest, geocode } from "../src/index.js";

function requestJson(path, body) {
  return new Request("https://spota.test" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.10" },
    body: JSON.stringify(body)
  });
}

function friendEnv(options = {}) {
  let friendshipWrites = 0;
  const env = {
    SOCIAL_WRITE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async first() {
                if (sql.includes("SELECT id FROM users")) return { id: "target-user" };
                if (sql.includes("SELECT 1 FROM blocks")) return null;
                if (sql.includes("SELECT id,status,requester_id")) {
                  return options.existing || {
                    id: "friendship-1", status: "pending",
                    requester_id: "me-user", addressee_id: "target-user"
                  };
                }
                if (sql.includes("COUNT(*) AS n")) return { n: options.pending || 0 };
                return null;
              },
              async run() {
                if (sql.includes("INSERT INTO app_config") &&
                    options.rejectDaily && String(values[0]).startsWith("ul_friend_request_")) {
                  return { meta: { changes: 0 } };
                }
                if (/INSERT INTO friendships|UPDATE friendships/.test(sql)) friendshipWrites += 1;
                return { meta: { changes: 1 } };
              }
            };
          }
        };
      }
    }
  };
  return { env, friendshipWrites: () => friendshipWrites };
}

test("friend routes reject unsupported HTTP methods before authentication", async () => {
  const cases = [
    ["/api/friends", "POST"],
    ["/api/friends/request", "GET"],
    ["/api/friends/accept", "DELETE"]
  ];
  for (const [path, method] of cases) {
    const response = await worker.fetch(new Request("https://spota.test" + path, { method }), {});
    assert.equal(response.status, 405, `${method} ${path}`);
  }
});

test("an existing outgoing friend request returns without another friendship write", async () => {
  const fake = friendEnv();
  const response = await friendRequest(
    requestJson("/api/friends/request", { handle: "target.user" }),
    fake.env,
    { id: "me-user" }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, status: "pending" });
  assert.equal(fake.friendshipWrites(), 0);
});

test("friend requests fail closed when the per-user daily limit is exhausted", async () => {
  const fake = friendEnv({ rejectDaily: true });
  const response = await friendRequest(
    requestJson("/api/friends/request", { handle: "target.user" }),
    fake.env,
    { id: "me-user" }
  );
  assert.equal(response.status, 429);
  assert.equal(fake.friendshipWrites(), 0);
});

test("cached geocode responses still pass through the client burst limiter", async () => {
  const previousCaches = globalThis.caches;
  let limitCalls = 0;
  let cacheReads = 0;
  globalThis.caches = { default: {
    async match() {
      cacheReads += 1;
      return new Response(JSON.stringify({ places: [] }), {
        headers: { "Content-Type": "application/json" }
      });
    },
    async put() {}
  } };
  const env = {
    GEOCODE_RATE_LIMITER: {
      async limit() { return { success: ++limitCalls === 1 }; }
    }
  };
  try {
    const first = await geocode(requestJson("/api/geocode", { q: "東京", limit: 4 }), env);
    const second = await geocode(requestJson("/api/geocode", { q: "東京", limit: 4 }), env);
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(limitCalls, 2);
    assert.equal(cacheReads, 1);
  } finally {
    if (previousCaches === undefined) delete globalThis.caches;
    else globalThis.caches = previousCaches;
  }
});

test("chunked JSON is stopped at the byte limit before full body expansion", async () => {
  const chunks = Array.from({ length: 6 }, () => new Uint8Array(900).fill(0x61));
  const stream = new ReadableStream({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    }
  });
  const request = new Request("https://spota.test/api/geocode", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half"
  });
  const response = await geocode(request, {
    GEOCODE_RATE_LIMITER: { limit: async () => ({ success: true }) }
  });
  assert.equal(response.status, 413);

  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const start = source.indexOf("async function limitedJson");
  const end = source.indexOf("function hourKey", start);
  assert.doesNotMatch(source.slice(start, end), /request\.text\(\)/);
  assert.match(source.slice(start, end), /readBodyLimited\(request, maxBytes\)/);
});
