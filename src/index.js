/**
 * 思い出保存アプリ / サーバー（Cloudflare Worker）
 *
 *  /api/*      … このコードが処理
 *  それ以外     … public/ の静的ファイル
 *
 *  必要なもの
 *   - D1  : binding "DB"
 *   - R2  : binding "PHOTOS"
 *   - Secret : HOTPEPPER_KEY
 *   - Var    : FIREBASE_PROJECT_ID
 *
 *  原則
 *   1. 真の座標は本人以外に絶対に返さない
 *   0. 反映は即時。遅延は設定で選ぶ（0 / 1h / 3h / 翌朝）
 *   2. 公開範囲の判定はすべてここで行う。画面側で隠すのは無意味
 *   3. 位置はランダムにずらさず、マス目へ吸着させる
 *      （ずらすだけだと、繰り返し観測して平均を取れば真の位置が割れる）
 */

const HP = "https://webservice.recruit.co.jp/hotpepper/gourmet/v1/";
const JWKS = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    // 静的ファイル。HTMLだけは毎回確認させる
    // （Safariが強くキャッシュするため、更新が反映されない事故を防ぐ）
    if (!p.startsWith("/api/")) {
      const res = await env.ASSETS.fetch(request);
      const ct = res.headers.get("Content-Type") || "";
      if (ct.includes("text/html")) {
        const h = new Headers(res.headers);
        h.set("Cache-Control", "no-cache, no-store, must-revalidate");
        return new Response(res.body, { status: res.status, headers: h });
      }
      return res;
    }

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    try {
      if (p === "/api/health") {
        const k = await getHpKey(env);
        return cors(json({
          ok: true,
          build: "api-7",
          hasKey: !!k.key,          // ホットペッパー
          keySource: k.src,
          hasRakuten: !!(await cfg(env, "rakuten_id")),
          hasDB: !!env.DB,
          hasR2: !!env.PHOTOS,
          firebase: env.FIREBASE_PROJECT_ID || null
        }));
      }
      if (p === "/api/hotpepper") return cors(await hotpepper(url, env));
      if (p === "/api/rakuten")   return cors(await rakuten(url, env));

      // ---- ここから先はログインが必要 ----
      const me = await authenticate(request, env);
      if (!me) return cors(json({ error: "ログインが必要です" }, 401));

      if (p === "/api/me" && request.method === "GET")    return cors(json(await getMe(env, me)));
      if (p === "/api/me" && request.method === "PATCH")  return cors(await patchMe(request, env, me));

      if (p === "/api/posts" && request.method === "GET")  return cors(await listPosts(url, env, me));
      if (p === "/api/posts" && request.method === "POST") return cors(await createPost(request, env, me));
      if (p.startsWith("/api/posts/") && request.method === "DELETE")
        return cors(await deletePost(p.split("/")[3], env, me));
      if (p.startsWith("/api/posts/") && request.method === "PATCH")
        return cors(await patchPost(p.split("/")[3], request, env, me));

      if (p === "/api/photo" && request.method === "PUT")  return cors(await putPhoto(url, request, env, me));
      if (p.startsWith("/api/photo/") && request.method === "GET")
        return cors(await getPhoto(p, env, me));

      if (p === "/api/friends" && request.method === "GET")  return cors(json(await listFriends(env, me)));
      if (p === "/api/friends/request") return cors(await friendRequest(request, env, me));
      if (p === "/api/friends/accept")  return cors(await friendAccept(request, env, me));
      if (p === "/api/block")           return cors(await blockUser(request, env, me));

      return cors(json({ error: "そのAPIはありません" }, 404));
    } catch (e) {
      return cors(json({ error: "サーバー内エラー: " + (e && e.message) }, 500));
    }
  }
};


/* ============================================================
   本人確認（Firebase の ID トークンを検証する）
   ============================================================ */

let jwksCache = null, jwksAt = 0;

async function getJwks() {
  const now = Date.now();
  if (jwksCache && now - jwksAt < 3600_000) return jwksCache;
  const r = await fetch(JWKS);
  jwksCache = await r.json();
  jwksAt = now;
  return jwksCache;
}

function b64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  const bin = atob(s + "=".repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyToken(token, projectId) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const header  = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(b64url(parts[1])));

  // 署名を確かめる
  const jwks = await getJwks();
  const jwk = (jwks.keys || []).find(k => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk", jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64url(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );
  if (!ok) return null;

  // 中身を確かめる
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return null;
  if (payload.aud !== projectId) return null;
  if (payload.iss !== "https://securetoken.google.com/" + projectId) return null;

  return payload;
}

/** トークンを検証し、users の行を返す。初回はここで作られる */
async function authenticate(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;

  const payload = await verifyToken(auth.slice(7), env.FIREBASE_PROJECT_ID);
  if (!payload) return null;

  const uid = payload.user_id || payload.sub;
  const signIn = (payload.firebase && payload.firebase.sign_in_provider) || "";
  const provider =
    signIn.includes("apple") ? "apple" :
    signIn.includes("phone") ? "phone" : "google";

  const found = await env.DB
    .prepare("SELECT user_id FROM identities WHERE provider=? AND provider_uid=?")
    .bind(provider, uid).first();

  if (found) {
    return await env.DB.prepare("SELECT * FROM users WHERE id=? AND deleted_at IS NULL")
      .bind(found.user_id).first();
  }

  // 初回ログイン：ユーザーとログイン手段をまとめて作る
  const userId = uuid();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, handle, display_name, created_at) VALUES (?,?,?,?)"
    ).bind(userId, null, payload.name || "", now),
    env.DB.prepare(
      "INSERT INTO identities (user_id, provider, provider_uid, email, phone, created_at) VALUES (?,?,?,?,?,?)"
    ).bind(userId, provider, uid, payload.email || null, payload.phone_number || null, now)
  ]);
  return await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(userId).first();
}


/* ============================================================
   位置の丸め方
   ずらす（ジッター）ではなく、マス目へ吸着させる。
   同じマスの投稿はすべて同じ座標になるので、
   何度観測されても真の位置は割り出せない。
   ============================================================ */

function snap(lat, lng, meters) {
  const dLat = meters / 111000;
  const dLng = meters / (111000 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return [
    Math.round(lat / dLat) * dLat + dLat / 2,
    Math.round(lng / dLng) * dLng + dLng / 2
  ];
}


/* ============================================================
   自分の情報と設定
   ============================================================ */

async function getMe(env, me) {
  return {
    id: me.id,
    handle: me.handle,
    display_name: me.display_name,
    bio: me.bio,
    settings: {
      default_visibility: me.default_visibility,
      friend_precision:   me.friend_precision,
      public_precision:   me.public_precision,
      publish_delay_sec:  me.publish_delay_sec,
      profile_public:     !!me.profile_public
    }
  };
}

async function patchMe(request, env, me) {
  const b = await request.json();
  const allow = {
    handle: "text", display_name: "text", bio: "text",
    default_visibility: ["private", "friends", "public"],
    friend_precision:   ["exact", "approx", "area", "hidden"],
    public_precision:   ["exact", "approx", "area", "hidden"],
    publish_delay_sec: "int", profile_public: "int"
  };
  const sets = [], vals = [];
  for (const k of Object.keys(allow)) {
    if (!(k in b)) continue;
    const rule = allow[k];
    if (Array.isArray(rule) && !rule.includes(b[k])) {
      return json({ error: k + " の値が不正です" }, 400);
    }
    sets.push(k + "=?");
    vals.push(rule === "int" ? (b[k] ? 1 : 0) | 0 : b[k]);
  }
  if (!sets.length) return json({ ok: true });
  vals.push(me.id);
  try {
    await env.DB.prepare("UPDATE users SET " + sets.join(",") + " WHERE id=?").bind(...vals).run();
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return json({ error: "そのIDは使われています" }, 409);
    throw e;
  }
  return json({ ok: true });
}


/* ============================================================
   投稿
   ============================================================ */

async function createPost(request, env, me) {
  const b = await request.json();
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!isFinite(lat) || !isFinite(lng)) return json({ error: "位置が不正です" }, 400);

  const now = Date.now();
  const vis = ["private", "friends", "public"].includes(b.visibility)
    ? b.visibility : me.default_visibility;

  const [aLat, aLng] = snap(lat, lng, 500);    // だいたい
  const [rLat, rLng] = snap(lat, lng, 2000);   // エリア

  const id = uuid();
  await env.DB.prepare(`
    INSERT INTO posts (
      id,user_id,place_id,title,category,tag,place_name,body,
      lat,lng,approx_lat,approx_lng,area_lat,area_lng,
      fixed_lat,fixed_lng,fixed_label,
      taken_at,created_at,visibility,publish_at
    ) VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?, ?,?,?,?)
  `).bind(
    id, me.id, b.place_id || null, b.title || "", b.category || "景",
    b.tag || "", b.place_name || "", b.body || "",
    lat, lng, aLat, aLng, rLat, rLng,
    b.fixed_lat ?? null, b.fixed_lng ?? null, b.fixed_label || null,
    b.taken_at || null, now, vis, now + (me.publish_delay_sec || 0) * 1000
  ).run();

  return json({ id, visibility: vis });
}

async function patchPost(id, request, env, me) {
  const b = await request.json();
  const own = await env.DB.prepare("SELECT user_id FROM posts WHERE id=?").bind(id).first();
  if (!own || own.user_id !== me.id) return json({ error: "権限がありません" }, 403);

  const sets = [], vals = [];
  if (["private", "friends", "public"].includes(b.visibility)) { sets.push("visibility=?"); vals.push(b.visibility); }
  for (const k of ["title", "tag", "category", "body"]) {
    if (k in b) { sets.push(k + "=?"); vals.push(b[k]); }
  }
  if ("fixed_lat" in b) {
    sets.push("fixed_lat=?", "fixed_lng=?", "fixed_label=?");
    vals.push(b.fixed_lat, b.fixed_lng, b.fixed_label || null);
  }
  if (!sets.length) return json({ ok: true });
  vals.push(id);
  await env.DB.prepare("UPDATE posts SET " + sets.join(",") + " WHERE id=?").bind(...vals).run();
  return json({ ok: true });
}

async function deletePost(id, env, me) {
  await env.DB.prepare("UPDATE posts SET deleted_at=? WHERE id=? AND user_id=?")
    .bind(Date.now(), id, me.id).run();
  return json({ ok: true });
}

/**
 * この範囲で「自分が見てよい投稿」を返す。
 * 座標の出し分けもSQLの中で済ませ、真の座標が外に出ないようにする。
 */
async function listPosts(url, env, me) {
  const s = Number(url.searchParams.get("s")), w = Number(url.searchParams.get("w"));
  const n = Number(url.searchParams.get("n")), e = Number(url.searchParams.get("e"));
  if (![s, w, n, e].every(isFinite)) return json({ error: "範囲の指定が不正です" }, 400);

  const now = Date.now();
  const limit = Math.min(300, Number(url.searchParams.get("limit") || 300));

  const rows = await env.DB.prepare(`
    WITH friend AS (
      SELECT CASE WHEN requester_id=?1 THEN addressee_id ELSE requester_id END AS uid
        FROM friendships
       WHERE status='accepted' AND (requester_id=?1 OR addressee_id=?1)
    )
    SELECT
      p.id, p.user_id, p.title, p.category, p.tag, p.place_name,
      p.taken_at, p.created_at, p.visibility,
      u.display_name, u.handle,
      (p.user_id = ?1) AS mine,
      CASE
        WHEN p.user_id = ?1 THEN 'exact'
        WHEN p.fixed_lat IS NOT NULL THEN 'fixed'
        WHEN p.user_id IN (SELECT uid FROM friend) THEN u.friend_precision
        ELSE u.public_precision
      END AS prec
    FROM posts p
    JOIN users u ON u.id = p.user_id
    WHERE p.deleted_at IS NULL
      AND p.area_lat BETWEEN ?2 AND ?3
      AND p.area_lng BETWEEN ?4 AND ?5
      AND (
            p.user_id = ?1
         OR ( p.publish_at <= ?6
              AND ( p.visibility='public'
                 OR (p.visibility='friends' AND p.user_id IN (SELECT uid FROM friend)) )
            )
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
         WHERE (b.blocker_id=?1 AND b.blocked_id=p.user_id)
            OR (b.blocker_id=p.user_id AND b.blocked_id=?1)
      )
    ORDER BY p.taken_at DESC, p.created_at DESC
    LIMIT ?7
  `).bind(me.id, s - 0.05, n + 0.05, w - 0.05, e + 0.05, now, limit).all();

  // 精度に応じた座標を、別クエリで安全に付け直す
  const out = [];
  for (const r of rows.results || []) {
    const c = await coordsFor(env, r);
    if (!c) continue;
    out.push({
      id: r.id, title: r.title, category: r.category, tag: r.tag,
      place_name: r.place_name, taken_at: r.taken_at,
      visibility: r.visibility, mine: !!r.mine,
      author: { id: r.user_id, name: r.display_name, handle: r.handle },
      lat: c[0], lng: c[1], precision: c[2]
    });
  }
  return json({ count: out.length, posts: out });
}

async function coordsFor(env, row) {
  const p = await env.DB.prepare(
    "SELECT lat,lng,approx_lat,approx_lng,area_lat,area_lng,fixed_lat,fixed_lng FROM posts WHERE id=?"
  ).bind(row.id).first();
  if (!p) return null;
  switch (row.prec) {
    case "exact":  return [p.lat, p.lng, "exact"];
    case "fixed":  return [p.fixed_lat, p.fixed_lng, "fixed"];
    case "approx": return [p.approx_lat, p.approx_lng, "approx"];
    case "area":   return [p.area_lat, p.area_lng, "area"];
    default:       return null;   // hidden は地図に出さない
  }
}


/* ============================================================
   写真（R2）
   ============================================================ */

async function putPhoto(url, request, env, me) {
  const postId = url.searchParams.get("post_id");
  const kind = url.searchParams.get("kind");            // orig / view / thumb
  if (!["orig", "view", "thumb"].includes(kind)) return json({ error: "kind が不正です" }, 400);

  const own = await env.DB.prepare("SELECT user_id FROM posts WHERE id=?").bind(postId).first();
  if (!own || own.user_id !== me.id) return json({ error: "権限がありません" }, 403);

  const photoId = url.searchParams.get("photo_id") || uuid();
  const key = `u/${me.id}/${postId}/${photoId}-${kind}.jpg`;

  await env.PHOTOS.put(key, request.body, {
    httpMetadata: { contentType: request.headers.get("Content-Type") || "image/jpeg" }
  });

  const col = kind === "orig" ? "key_orig" : kind === "view" ? "key_view" : "key_thumb";
  const exists = await env.DB.prepare("SELECT id FROM photos WHERE id=?").bind(photoId).first();
  if (exists) {
    await env.DB.prepare(`UPDATE photos SET ${col}=? WHERE id=?`).bind(key, photoId).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO photos (id,post_id,user_id,${col},created_at) VALUES (?,?,?,?,?)`
    ).bind(photoId, postId, me.id, key, Date.now()).run();
  }
  return json({ photo_id: photoId, kind });
}

/** GET /api/photo/{photoId}/{kind} — 見てよい相手かを必ず確かめてから返す */
async function getPhoto(path, env, me) {
  const [, , , photoId, kind] = path.split("/");
  const ph = await env.DB.prepare("SELECT * FROM photos WHERE id=?").bind(photoId).first();
  if (!ph) return json({ error: "見つかりません" }, 404);

  const post = await env.DB.prepare("SELECT * FROM posts WHERE id=? AND deleted_at IS NULL")
    .bind(ph.post_id).first();
  if (!post) return json({ error: "見つかりません" }, 404);

  if (post.user_id !== me.id) {
    if (post.publish_at > Date.now() || post.visibility === "private") {
      return json({ error: "権限がありません" }, 403);
    }
    if (post.visibility === "friends" && !(await areFriends(env, me.id, post.user_id))) {
      return json({ error: "権限がありません" }, 403);
    }
    if (await isBlocked(env, me.id, post.user_id)) return json({ error: "権限がありません" }, 403);
  }

  const key = kind === "orig" ? ph.key_orig : kind === "thumb" ? ph.key_thumb : ph.key_view;
  if (!key) return json({ error: "その大きさはありません" }, 404);

  const obj = await env.PHOTOS.get(key);
  if (!obj) return json({ error: "見つかりません" }, 404);

  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
      "Cache-Control": "private, max-age=86400"
    }
  });
}


/* ============================================================
   フレンド
   ============================================================ */

async function areFriends(env, a, b) {
  const r = await env.DB.prepare(`
    SELECT 1 FROM friendships
     WHERE status='accepted'
       AND ((requester_id=?1 AND addressee_id=?2) OR (requester_id=?2 AND addressee_id=?1))
  `).bind(a, b).first();
  return !!r;
}

async function isBlocked(env, a, b) {
  const r = await env.DB.prepare(`
    SELECT 1 FROM blocks
     WHERE (blocker_id=?1 AND blocked_id=?2) OR (blocker_id=?2 AND blocked_id=?1)
  `).bind(a, b).first();
  return !!r;
}

async function listFriends(env, me) {
  const acc = await env.DB.prepare(`
    SELECT u.id,u.handle,u.display_name FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.requester_id=?1 THEN f.addressee_id ELSE f.requester_id END
     WHERE f.status='accepted' AND (f.requester_id=?1 OR f.addressee_id=?1)
  `).bind(me.id).all();

  const inc = await env.DB.prepare(`
    SELECT u.id,u.handle,u.display_name FROM friendships f
      JOIN users u ON u.id=f.requester_id
     WHERE f.status='pending' AND f.addressee_id=?1
  `).bind(me.id).all();

  return { friends: acc.results || [], incoming: inc.results || [] };
}

async function friendRequest(request, env, me) {
  const { handle } = await request.json();
  const target = await env.DB.prepare("SELECT id FROM users WHERE handle=? AND deleted_at IS NULL")
    .bind(handle).first();
  if (!target) return json({ error: "そのIDのユーザーはいません" }, 404);
  if (target.id === me.id) return json({ error: "自分には申請できません" }, 400);
  if (await isBlocked(env, me.id, target.id)) return json({ error: "申請できません" }, 403);

  const now = Date.now();
  // 相手からの申請が既にあれば、その場で成立させる
  const rev = await env.DB.prepare(
    "SELECT id FROM friendships WHERE requester_id=? AND addressee_id=? AND status='pending'"
  ).bind(target.id, me.id).first();
  if (rev) {
    await env.DB.prepare("UPDATE friendships SET status='accepted',updated_at=? WHERE id=?")
      .bind(now, rev.id).run();
    return json({ ok: true, status: "accepted" });
  }

  await env.DB.prepare(`
    INSERT INTO friendships (requester_id,addressee_id,status,created_at,updated_at)
    VALUES (?,?,'pending',?,?)
    ON CONFLICT(requester_id,addressee_id) DO UPDATE SET status='pending',updated_at=?
  `).bind(me.id, target.id, now, now, now).run();
  return json({ ok: true, status: "pending" });
}

async function friendAccept(request, env, me) {
  const { user_id } = await request.json();
  const r = await env.DB.prepare(`
    UPDATE friendships SET status='accepted',updated_at=?
     WHERE requester_id=? AND addressee_id=? AND status='pending'
  `).bind(Date.now(), user_id, me.id).run();
  return json({ ok: true, changed: r.meta ? r.meta.changes : 0 });
}

async function blockUser(request, env, me) {
  const { user_id } = await request.json();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO blocks (blocker_id,blocked_id,created_at) VALUES (?,?,?)"
  ).bind(me.id, user_id, Date.now()).run();
  await env.DB.prepare(`
    UPDATE friendships SET status='rejected',updated_at=?
     WHERE (requester_id=?1 AND addressee_id=?2) OR (requester_id=?2 AND addressee_id=?1)
  `).bind(Date.now(), me.id, user_id).run();
  return json({ ok: true });
}


/* ============================================================
   ホットペッパー中継（既存）
   ============================================================ */

/**
 * ホットペッパーのキーを探す。
 *  1. Cloudflare のシークレット
 *  2. D1 の app_config テーブル  ← デプロイで消えない
 * 同じ isolate の中では覚えておき、毎回D1を読まないようにする。
 */
const cfgCache = {};
async function cfg(env, key) {
  if (cfgCache[key] !== undefined) return cfgCache[key];
  try {
    const r = await env.DB.prepare("SELECT v FROM app_config WHERE k=?").bind(key).first();
    cfgCache[key] = (r && r.v) ? r.v : null;
  } catch (e) { cfgCache[key] = null; }
  return cfgCache[key];
}
async function getHpKey(env) {
  if (env.HOTPEPPER_KEY) return { key: env.HOTPEPPER_KEY, src: "env" };
  const v = await cfg(env, "hotpepper_key");
  return { key: v, src: v ? "d1" : "none" };
}

async function hotpepper(url, env) {
  const got = await getHpKey(env);
  const key = got.key;
  if (!key) return json({ error: "ホットペッパーのキーが見つかりません（envにもD1にもありません）" }, 500);

  const lat = url.searchParams.get("lat"), lng = url.searchParams.get("lng");
  const range = url.searchParams.get("range") || "5";
  const keyword = url.searchParams.get("keyword") || "";
  // キーワード検索のときは位置が無くてもよい（全国から探す）
  if (!keyword && (!lat || !lng)) return json({ error: "lat / lng が必要です" }, 400);

  const shops = [];
  let available = 0;
  const pages = Math.min(3, Number(url.searchParams.get("pages") || 2));

  for (let page = 0; page < pages; page++) {
    const api = new URL(HP);
    api.searchParams.set("key", key);
    if (lat && lng) {
      api.searchParams.set("lat", lat);
      api.searchParams.set("lng", lng);
      api.searchParams.set("range", range);
    }
    if (keyword) api.searchParams.set("keyword", keyword);
    api.searchParams.set("count", "100");
    api.searchParams.set("start", String(page * 100 + 1));
    api.searchParams.set("format", "json");

    const res = await fetch(api.toString(), { cf: { cacheTtl: 3600 } });
    if (!res.ok) return json({ error: "ホットペッパー HTTP " + res.status }, 502);

    const body = await res.json();
    const r = body && body.results;
    if (!r) return json({ error: "応答の形式が想定と違います" }, 502);
    if (r.error) return json({ error: "API: " + (r.error[0] && r.error[0].message) }, 502);

    available = Number(r.results_available) || 0;
    const list = r.shop || [];
    for (const s of list) {
      shops.push({
        hpid: s.id, n: s.name, lat: Number(s.lat), lng: Number(s.lng),
        genre: s.genre ? s.genre.code : "", gname: s.genre ? s.genre.name : "",
        addr: s.address || "", budget: s.budget ? s.budget.name : "",
        url: s.urls ? s.urls.pc : "",
        photo: s.photo && s.photo.mobile ? (s.photo.mobile.l || s.photo.mobile.s) : ""
      });
    }
    if (list.length < 100 || shops.length >= available) break;
  }
  return json({ count: shops.length, available, shops });
}


/* ============================================================
   小道具
   ============================================================ */

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  h.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  return new Response(res.body, { status: res.status, headers: h });
}


/* ============================================================
   楽天トラベル / 施設検索
   アプリIDは D1 の app_config に入れる。
   応答に含めないので、外には出ない。
   ============================================================ */
const RK = "https://app.rakuten.co.jp/services/api/Travel/SimpleHotelSearch/20170426";

async function rakuten(url, env) {
  const id = await cfg(env, "rakuten_id");
  if (!id) return json({ error: "楽天のアプリIDが未設定です" }, 500);

  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!isFinite(lat) || !isFinite(lng)) return json({ error: "lat / lng が必要です" }, 400);

  // searchRadius は 0.1〜3.0 km。小数第1位まで
  let km = Number(url.searchParams.get("km") || 3);
  if (!isFinite(km)) km = 3;
  km = Math.min(3, Math.max(0.1, Math.round(km * 10) / 10));

  const api = new URL(RK);
  api.searchParams.set("applicationId", String(id).trim());
  api.searchParams.set("format", "json");
  api.searchParams.set("datumType", "1");                 // 1 = 世界測地系（度）
  api.searchParams.set("latitude", lat.toFixed(6));
  api.searchParams.set("longitude", lng.toFixed(6));
  api.searchParams.set("searchRadius", km.toFixed(1));
  api.searchParams.set("hits", "30");

  const res = await fetch(api.toString(), {
    cf: { cacheTtl: 3600 },
    headers: { "User-Agent": "michikusa/1.0" }
  });

  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) {}

  if (!res.ok) {
    // 楽天は該当なしのときも 404 を返す
    if (res.status === 404) return json({ count: 0, hotels: [] });
    return json({
      error: "楽天トラベル HTTP " + res.status,
      detail: body ? (body.error_description || body.error) : text.slice(0, 300),
      // 診断用。アプリIDは伏せる
      sent: { lat: lat.toFixed(6), lng: lng.toFixed(6), km: km.toFixed(1) }
    }, 502);
  }

  if (body && body.error) {
    return json({ error: "楽天: " + (body.error_description || body.error) }, 502);
  }

  const hotels = [];
  ((body && body.hotels) || []).forEach(function (h) {
    const arr = h.hotel || [];
    let info = null;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].hotelBasicInfo) { info = arr[i].hotelBasicInfo; break; }
    }
    if (!info) return;
    const la = Number(info.latitude), ln = Number(info.longitude);
    if (!isFinite(la) || !isFinite(ln)) return;
    hotels.push({
      id: String(info.hotelNo || ""),
      n: info.hotelName || "",
      lat: la,
      lng: ln,
      addr: [info.address1, info.address2].filter(Boolean).join(""),
      photo: info.hotelImageUrl || info.hotelThumbnailUrl || "",
      min: info.hotelMinCharge || null,
      url: info.hotelInformationUrl || ""
    });
  });

  return json({ count: hotels.length, hotels: hotels });
}
