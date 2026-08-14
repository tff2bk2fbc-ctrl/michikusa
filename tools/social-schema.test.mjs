import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);
const migration = readFileSync(new URL("migrations/0001_social_release.sql", root), "utf8");
const worker = readFileSync(new URL("src/index.js", root), "utf8");
const wrangler = JSON.parse(readFileSync(new URL("wrangler.jsonc", root), "utf8"));

const baseSchema = `
PRAGMA foreign_keys=ON;
CREATE TABLE users (id TEXT PRIMARY KEY);
CREATE TABLE posts (
  id TEXT PRIMARY KEY,user_id TEXT NOT NULL,visibility TEXT NOT NULL,
  created_at INTEGER NOT NULL,deleted_at INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE photos (
  id TEXT PRIMARY KEY,post_id TEXT NOT NULL,user_id TEXT NOT NULL,
  key_orig TEXT,key_view TEXT,key_thumb TEXT,sort_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE friendships (
  id INTEGER PRIMARY KEY,requester_id TEXT NOT NULL,addressee_id TEXT NOT NULL,
  status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
  UNIQUE(requester_id,addressee_id)
);
CREATE TABLE blocks (
  blocker_id TEXT NOT NULL,blocked_id TEXT NOT NULL,created_at INTEGER NOT NULL,
  PRIMARY KEY(blocker_id,blocked_id)
);
INSERT INTO users(id) VALUES ('u1'),('u2'),('u3');
INSERT INTO posts(id,user_id,visibility,created_at) VALUES ('post-old','u1','public',1);
INSERT INTO photos(id,post_id,user_id,key_view,key_thumb,created_at)
  VALUES ('photo-old','post-old','u1','view-key','thumb-key',1);
`;

test("social migration applies atomically to the existing core schema", () => {
  const checks = `
SELECT 'VIS='||visibility FROM posts WHERE id='post-old';
SELECT 'PHOTO='||moderation_state||','||moderation_view_state||','||moderation_thumb_state
  FROM photos WHERE id='photo-old';
SELECT 'TABLES='||COUNT(*) FROM sqlite_master WHERE type='table' AND name IN
  ('follows','post_likes','post_comments','post_hashtags','conversations',
   'conversation_members','messages','notifications','social_albums',
   'social_album_items','share_links');
SELECT 'FK='||COUNT(*) FROM pragma_foreign_key_check;
`;
  const result = spawnSync("sqlite3", [":memory:"], {
    input: baseSchema + migration + checks,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^VIS=private$/m);
  assert.match(result.stdout, /^PHOTO=legacy,legacy,legacy$/m);
  assert.match(result.stdout, /^TABLES=11$/m);
  assert.match(result.stdout, /^FK=0$/m);
});

test("post announcement inserts every authorized recipient in one SQL statement", () => {
  const match = /const notificationInsert = env\.DB\.prepare\(`([\s\S]*?)`\)\.bind/.exec(worker);
  assert.ok(match, "announcement SQL was not found");
  let announcement = match[1];
  const values = { 1: "'u1'", 2: "'public'", 3: "'post-old'", 4: "'post:post-old'", 5: "2" };
  for (const number of [5, 4, 3, 2, 1])
    announcement = announcement.replaceAll(`?${number}`, values[number]);
  const sql = baseSchema + migration + `
INSERT INTO friendships(id,requester_id,addressee_id,status,created_at,updated_at)
  VALUES (1,'u1','u2','accepted',1,1);
INSERT INTO follows(follower_id,followee_id,created_at) VALUES ('u3','u1',1);
${announcement};
SELECT 'RECIPIENTS='||COUNT(*) FROM notifications WHERE dedupe_key='post:post-old';
`;
  const result = spawnSync("sqlite3", [":memory:"], { input: sql, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^RECIPIENTS=2$/m);
});

test("social endpoints keep authorization, composite cursors and variant moderation", () => {
  const auth = worker.indexOf("const me = await authenticate(request, env)");
  for (const route of ["/api/feed", "/api/notifications", "/api/conversations", "/api/albums", "/api/shares"])
    assert.ok(worker.indexOf(route) > auth, `${route} must be after authentication`);
  assert.match(worker, /moderation_view_state/);
  assert.match(worker, /moderation_thumb_state/);
  assert.match(worker, /c\.created_at<\?2 OR \(c\.created_at=\?2 AND c\.id<\?3\)/);
  assert.match(worker, /m\.created_at<\?2 OR \(m\.created_at=\?2 AND m\.id<\?3\)/);
  assert.match(worker, /last_read_id/);
  assert.match(worker, /SOCIAL_READ_RATE_LIMITER/);
  assert.match(worker, /SOCIAL_WRITE_RATE_LIMITER/);
  assert.match(worker, /SHARE_RATE_LIMITER/);
  assert.doesNotMatch(worker.slice(worker.indexOf("async function announcePostIfReady"), worker.indexOf("async function announceReadyPosts")), /LIMIT 50/);
});

test("wrangler declares social burst limits and frequent delayed publishing", () => {
  const names = new Set((wrangler.ratelimits || []).map(item => item.name));
  for (const name of ["SOCIAL_READ_RATE_LIMITER", "SOCIAL_WRITE_RATE_LIMITER", "SHARE_RATE_LIMITER"])
    assert.ok(names.has(name), `${name} is missing`);
  assert.ok(wrangler.triggers.crons.includes("*/15 * * * *"));
  assert.ok(wrangler.triggers.crons.includes("17 18 * * *"));
});
