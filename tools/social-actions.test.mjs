import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createComment,
  deleteLike,
  flashPost,
  listComments,
  putLike,
} from "../src/index.js";

class D1Statement {
  constructor(db, sql, values = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }
  bind(...values) { return new D1Statement(this.db, this.sql, values); }
  async first() { return this.db.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.values) }; }
  async run() {
    const result = this.db.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class LocalD1 {
  constructor() { this.sqlite = new DatabaseSync(":memory:"); }
  prepare(sql) { return new D1Statement(this.sqlite, sql); }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function socialEnv() {
  const DB = new LocalD1();
  DB.sqlite.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, handle TEXT, display_name TEXT, deleted_at INTEGER
    );
    CREATE TABLE posts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, tag TEXT, body TEXT,
      place_name TEXT, visibility TEXT NOT NULL, publish_at INTEGER NOT NULL,
      deleted_at INTEGER, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY, post_id TEXT NOT NULL, key_thumb TEXT,
      moderation_state TEXT, FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
    );
    CREATE TABLE friendships (
      requester_id TEXT NOT NULL, addressee_id TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE blocks (
      blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL,
      PRIMARY KEY(blocker_id,blocked_id)
    );
    CREATE TABLE post_likes (
      post_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(post_id,user_id),
      FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE post_comments (
      id TEXT PRIMARY KEY, post_id TEXT NOT NULL, user_id TEXT NOT NULL,
      body TEXT NOT NULL, client_operation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
      UNIQUE(post_id,user_id,client_operation_id),
      FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, actor_id TEXT, kind TEXT NOT NULL,
      entity_type TEXT, entity_id TEXT, dedupe_key TEXT NOT NULL,
      created_at INTEGER NOT NULL, read_at INTEGER,
      UNIQUE(user_id,dedupe_key)
    );
    CREATE TABLE post_flashes (
      post_id TEXT NOT NULL, user_id TEXT NOT NULL,
      recipient_count INTEGER NOT NULL DEFAULT 0 CHECK(recipient_count BETWEEN 0 AND 5),
      created_at INTEGER NOT NULL, PRIMARY KEY(post_id,user_id),
      FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE app_config (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  const insertUser = DB.sqlite.prepare(
    "INSERT INTO users(id,handle,display_name) VALUES (?,?,?)"
  );
  insertUser.run("owner-user", "owner", "投稿者");
  insertUser.run("actor-user", "actor", "操作する人");
  for (let i = 1; i <= 6; i++)
    insertUser.run(`recipient-${i}`, `recipient${i}`, `受信者${i}`);
  DB.sqlite.prepare(`INSERT INTO posts
    (id,user_id,title,tag,body,place_name,visibility,publish_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
      "post-action-1", "owner-user", "思い出", "#旅", "本文", "東京", "public", Date.now() - 1000
    );
  DB.sqlite.prepare(`INSERT INTO photos(id,post_id,key_thumb,moderation_state)
    VALUES (?,?,?,?)`).run("photo-action-1", "post-action-1", "thumb-key", "ok");
  return { DB, SOCIAL_WRITE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SOCIAL_READ_RATE_LIMITER: { limit: async () => ({ success: true }) } };
}

const actor = { id: "actor-user", handle: "actor", display_name: "操作する人" };

test("いいね・コメント・Flashが実際のSQLite制約下で保存・再取得できる", async () => {
  const env = socialEnv();

  const like = await putLike("post-action-1", env, actor);
  assert.equal(like.status, 200);
  assert.deepEqual(await like.json(), { ok: true, liked: true, count: 1 });
  await putLike("post-action-1", env, actor);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM post_likes").get().n, 1);
  assert.equal(env.DB.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM notifications WHERE kind='like'"
  ).get().n, 1);

  const commentRequest = new Request("https://spota.test/api/posts/post-action-1/comments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: "きれいな場所ですね", client_operation_id: "comment-op-1" })
  });
  const created = await createComment("post-action-1", commentRequest, env, actor);
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.body, "きれいな場所ですね");
  const listed = await listComments(
    "post-action-1", new URL("https://spota.test/comments?limit=30"), env, actor
  );
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).comments.map(row => row.body), ["きれいな場所ですね"]);
  assert.equal(env.DB.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM notifications WHERE kind='comment'"
  ).get().n, 1);

  // 投稿者をブロックした利用者へ、第三者のFlash経由で投稿を迂回配信しない。
  env.DB.sqlite.prepare("INSERT INTO blocks(blocker_id,blocked_id) VALUES (?,?)")
    .run("recipient-1", "owner-user");
  const flashed = await flashPost("post-action-1", env, actor);
  assert.equal(flashed.status, 200);
  const flashBody = await flashed.json();
  assert.equal(flashBody.flashed, true);
  assert.equal(flashBody.recipient_count, 5);
  assert.equal(flashBody.flash_count, 1);
  const replayed = await flashPost("post-action-1", env, actor);
  assert.equal((await replayed.json()).replayed, true);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM post_flashes").get().n, 1);
  assert.equal(env.DB.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM notifications WHERE kind='flash'"
  ).get().n, 5);
  assert.equal(env.DB.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM notifications WHERE kind='flash' AND user_id='recipient-1'"
  ).get().n, 0);

  const unliked = await deleteLike("post-action-1", env, actor);
  assert.deepEqual(await unliked.json(), { ok: true, liked: false, count: 0 });
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM post_likes").get().n, 0);
  const reliked = await putLike("post-action-1", env, actor);
  assert.equal(reliked.status, 200);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM post_likes").get().n, 1);
  assert.equal(env.DB.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM notifications WHERE kind='like'"
  ).get().n, 1, "unlike and re-like must not regenerate a notification");
  env.DB.sqlite.close();
});
