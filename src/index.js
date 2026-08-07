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
          build: "api-25",
          hasKey: !!k.key,          // ホットペッパー
          keySource: k.src,
          hasRakuten: !!(await cfg(env, "rakuten_id")),
          hasRakutenKey: !!(await cfg(env, "rakuten_key")),
          hasGoogle: !!(await cfg(env, "google_key")),
          quota: await quotaState(env),
          hasDB: !!env.DB,
          hasR2: !!env.PHOTOS,
          firebase: env.FIREBASE_PROJECT_ID || null
        }));
      }
      if (p === "/api/hotpepper") return cors(await hotpepper(url, env));
      if (p === "/api/rakuten")   return cors(await rakuten(url, env));
      if (p === "/api/places")    return cors(await nearbyPlaces(url, env));
      if (p === "/api/wiki")      return cors(await wiki(url, env));
      if (p === "/api/vision" && request.method === "POST")  return cors(await vision(request, env, me));
      if (p === "/api/suggest" && request.method === "POST") return cors(await suggest(request, env, me));
      if (p === "/api/push/token" && request.method === "POST") return cors(await saveToken(request, env, me));
      if (p === "/api/push/test"  && request.method === "POST") return cors(await pushTest(env, me));
      if (p === "/api/tags" && request.method === "POST")  return cors(await addTags(request, env, me));
      if (p === "/api/tags" && request.method === "GET")   return cors(await myTags(env, me));
      if (p === "/api/tags/accept" && request.method === "POST") return cors(await takeTag(request, env, me));
      if (p === "/api/img")       return await proxyImage(url);

      // ---- ここから先はログインが必要 ----
      const me = await authenticate(request, env);
      if (!me) return cors(json({ error: "ログインが必要です" }, 401));

      if (p === "/api/gsearch")   return cors(await gsearch(url, env, me));
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
  // IDは一度決めたら変えられない。
  // 配ったQRやリンクが死ぬのと、なりすましを防ぐため。
  if ("handle" in b) {
    if (me.handle) {
      return json({ error: "IDは変更できません" }, 409);
    }
    const hd = String(b.handle || "").trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(hd)) {
      return json({ error: "IDは英数字と_で3〜20文字にしてください" }, 400);
    }
    const taken = await env.DB
      .prepare("SELECT 1 FROM users WHERE lower(handle)=lower(?) AND id<>?")
      .bind(hd, me.id).first();
    if (taken) {
      return json({ error: "そのIDは既に使われています", code: "taken" }, 409);
    }
    b.handle = hd;
  }

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
    if (String(e.message).includes("UNIQUE"))
      return json({ error: "そのIDは既に使われています", code: "taken" }, 409);
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

  // フレンドに見せる投稿なら、相手に知らせる
  if (vis !== "private") {
    try {
      const fr = await env.DB.prepare(`
        SELECT CASE WHEN requester_id=?1 THEN addressee_id ELSE requester_id END AS uid
          FROM friendships
         WHERE status='accepted' AND (requester_id=?1 OR addressee_id=?1)
         LIMIT 20
      `).bind(me.id).all();
      const who = me.display_name || me.handle || "フレンド";
      for (const f of (fr.results || [])) {
        await sendPush(env, f.uid, who + " が思い出を残しました",
          b.title || b.place_name || "", { lat: String(lat), lng: String(lng), post: id });
      }
    } catch (e) {}
  }

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
    const tagged = await env.DB.prepare(
      "SELECT 1 FROM post_tags WHERE post_id=? AND user_id=?"
    ).bind(post.id, me.id).first();
    if (!tagged && post.visibility === "friends" &&
        !(await areFriends(env, me.id, post.user_id))) {
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
  // 取ってきたものは、こちらにも残しておく
  await savePlaces(env, shops.map(function (s) {
    return { n: s.n, lat: s.lat, lng: s.lng, c: "食",
             src: "hotpepper", sid: s.hpid, addr: s.addr, gname: s.gname, budget: s.budget };
  }));

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
/* 2026年2月の刷新で、ドメイン・パス・認証方式がすべて変わった。
   旧 app.rakuten.co.jp は5月14日に停止済み。
   新方式では applicationId に加えて accessKey がヘッダーで必須。 */
const RK = "https://openapi.rakuten.co.jp/engine/api/Travel/SimpleHotelSearch/20260731";

async function rakuten(url, env) {
  const id = await cfg(env, "rakuten_id");
  const ak = await cfg(env, "rakuten_key");
  if (!id) return json({ error: "楽天のアプリケーションIDが未設定です" }, 500);
  if (!ak) return json({ error: "楽天のアクセスキーが未設定です（rakuten_key）" }, 500);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!isFinite(lat) || !isFinite(lng)) return json({ error: "lat / lng が必要です" }, 400);

  let km = Number(url.searchParams.get("km") || 3);
  if (!isFinite(km)) km = 3;
  km = Math.min(3, Math.max(0.1, Math.round(km * 10) / 10));

  const api = new URL(RK);
  api.searchParams.set("applicationId", String(id).trim());
  api.searchParams.set("format", "json");
  api.searchParams.set("datumType", "1");            // 1 = 世界測地系（度）
  api.searchParams.set("latitude", lat.toFixed(6));
  api.searchParams.set("longitude", lng.toFixed(6));
  api.searchParams.set("searchRadius", km.toFixed(1));
  api.searchParams.set("hits", "30");

  // 新方式は送信元の申告にも厳しい。登録した許可サイトと一致させる
  const site = (await cfg(env, "rakuten_site")) || url.origin;
  api.searchParams.set("httpReferer", site);

  const res = await fetch(api.toString(), {
    cf: { cacheTtl: 3600 },
    headers: {
      "accessKey": String(ak).trim(),        // 新方式で必須
      "Referer": site,
      "Origin": site,
      "User-Agent": "michikusa/1.0",
      "Accept": "application/json"
    }
  });

  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) {}

  if (!res.ok) {
    if (res.status === 404) return json({ count: 0, hotels: [] });   // 該当なし
    return json({
      error: "楽天トラベル HTTP " + res.status,
      detail: body ? (body.error_description || body.error) : text.slice(0, 400),
      sentSite: site,
      idLen: String(id).trim().length,
      keyLen: String(ak).trim().length
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
      lat: la, lng: ln,
      addr: [info.address1, info.address2].filter(Boolean).join(""),
      photo: info.hotelImageUrl || info.hotelThumbnailUrl || "",
      min: info.hotelMinCharge || null,
      url: info.hotelInformationUrl || ""
    });
  });

  await savePlaces(env, hotels.map(function (x) {
    return { n: x.n, lat: x.lat, lng: x.lng, c: "宿",
             src: "user", sid: "rk_" + x.id, addr: x.addr,
             gname: x.min ? ("1泊 " + Number(x.min).toLocaleString() + "円〜") : "宿" };
  }));

  return json({ count: hotels.length, hotels: hotels });
}


/* ============================================================
   画像の中継

   よその画像をそのまま Canvas で加工しようとすると、
   ブラウザが安全のために止めてしまう。
   一度こちらを通せば自分の画像として扱えるので、加工できる。
   ============================================================ */
const IMG_OK = [
  "img.travel.rakuten.co.jp",
  "imgfp.hotp.jp",
  "imgfp.hotp.jp.",
  "upload.wikimedia.org",
  "img.hotp.jp"
];

async function proxyImage(url) {
  const src = url.searchParams.get("u");
  if (!src) return new Response("u が必要です", { status: 400 });

  let t;
  try { t = new URL(src); } catch (e) { return new Response("URLが不正です", { status: 400 }); }
  if (t.protocol !== "https:") return new Response("https だけです", { status: 400 });

  // 決めた場所からの画像だけ通す（何でも中継すると踏み台にされる）
  const okHost = IMG_OK.some(function (d) {
    return t.hostname === d || t.hostname.endsWith("." + d);
  });
  if (!okHost) return new Response("その場所は許可していません", { status: 403 });

  const res = await fetch(t.toString(), {
    cf: { cacheTtl: 86400, cacheEverything: true },
    headers: { "User-Agent": "michikusa/1.0" }
  });
  if (!res.ok) return new Response("取得できません " + res.status, { status: 502 });

  const ct = res.headers.get("Content-Type") || "";
  if (!ct.startsWith("image/")) return new Response("画像ではありません", { status: 415 });

  return new Response(res.body, {
    headers: {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=604800",
      "Access-Control-Allow-Origin": "*"
    }
  });
}


/* ============================================================
   Google の場所検索

   使うのは検索だけ。地図の表示には使わない。
   （地図は自前のものを使い続ける。見た目が資産なので）

   料金は「取り出す項目の種類」で段階が変わる。
   必要な項目だけを指定して、安い段階に収める。
   ============================================================ */
const GPLACES = "https://places.googleapis.com/v1/places:searchText";

async function gsearch(url, env, me) {
  const key = await cfg(env, "google_key");
  if (!key) return json({ error: "Googleのキーが未設定です" }, 500);

  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ error: "探す言葉が必要です" }, 400);

  if (!(await useQuota(env, "gsearch", me && me.id))) {
    return json({ count: 0, places: [], capped: true });   // 上限。黙って空を返す
  }

  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));

  const body = {
    textQuery: q,
    languageCode: "ja",
    regionCode: "JP",
    maxResultCount: 10
  };
  // 近くを優先する。位置が分かるときだけ
  if (isFinite(lat) && isFinite(lng)) {
    body.locationBias = {
      circle: { center: { latitude: lat, longitude: lng }, radius: 30000 }
    };
  }

  // 取り出す項目を絞る。ここを増やすと段階が上がって高くなる
  const fields = [
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.location",
    "places.primaryTypeDisplayName",
    "places.types"
  ].join(",");

  const res = await fetch(GPLACES, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": fields
    },
    body: JSON.stringify(body),
    cf: { cacheTtl: 3600, cacheEverything: true }
  });

  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) {}

  if (!res.ok) {
    return json({
      error: "Google HTTP " + res.status,
      detail: (j && j.error && j.error.message) || text.slice(0, 300)
    }, 502);
  }

  const out = [];
  ((j && j.places) || []).forEach(function (p) {
    const loc = p.location || {};
    if (!isFinite(loc.latitude) || !isFinite(loc.longitude)) return;
    out.push({
      gid: p.id || "",
      n: (p.displayName && p.displayName.text) || "",
      lat: loc.latitude,
      lng: loc.longitude,
      addr: p.formattedAddress || "",
      gname: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || "",
      types: p.types || []
    });
  });

  await savePlaces(env, out.map(function (g) {
    return { n: g.n, lat: g.lat, lng: g.lng, c: "景",
             src: "user", sid: "g_" + g.gid, addr: g.addr, gname: g.gname };
  }));

  return json({ count: out.length, places: out });
}


/* ============================================================
   自前の場所マスタ

   外から取ってきたものは、そのつど places に貯める。
   同じところを二度取りに行かなくて済むし、
   外のサービスが止まっても地図が空にならない。
   ============================================================ */

/** この範囲にある、貯めてある場所を返す */
async function nearbyPlaces(url, env) {
  const s = Number(url.searchParams.get("s"));
  const w = Number(url.searchParams.get("w"));
  const n = Number(url.searchParams.get("n"));
  const e = Number(url.searchParams.get("e"));
  if (![s, w, n, e].every(isFinite)) return json({ error: "範囲の指定が不正です" }, 400);

  const limit = Math.min(400, Number(url.searchParams.get("limit") || 300));

  const rows = await env.DB.prepare(`
    SELECT id, name, lat, lng, category, genre, budget, address, source
      FROM places
     WHERE lat BETWEEN ?1 AND ?2 AND lng BETWEEN ?3 AND ?4
     LIMIT ?5
  `).bind(s, n, w, e, limit).all();

  const out = (rows.results || []).map(function (r) {
    return {
      n: r.name, lat: r.lat, lng: r.lng,
      c: r.category, gname: r.genre || "", budget: r.budget || "",
      addr: r.address || "", src: r.source
    };
  });
  return json({ count: out.length, places: out });
}

/** 取ってきたものを貯める。同じものは上書きしない */
async function savePlaces(env, list) {
  if (!list || !list.length) return 0;
  const now = Date.now();
  const stmts = [];
  for (const p of list) {
    if (!p.n || !isFinite(p.lat) || !isFinite(p.lng)) continue;
    const sid = p.sid || (p.n + "_" + p.lat.toFixed(5) + "_" + p.lng.toFixed(5));
    stmts.push(
      env.DB.prepare(`
        INSERT INTO places (id,name,lat,lng,category,source,source_id,address,genre,budget,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source, source_id) DO NOTHING
      `).bind(
        crypto.randomUUID ? crypto.randomUUID() : ("p" + now + Math.random()),
        p.n, p.lat, p.lng, p.c || "景", p.src || "user", sid,
        p.addr || null, p.gname || null, p.budget || null, now
      )
    );
  }
  if (!stmts.length) return 0;
  try {
    // 一度に送れる数には限りがあるので、小分けにする
    for (let i = 0; i < stmts.length; i += 50) {
      await env.DB.batch(stmts.slice(i, i + 50));
    }
  } catch (e) { return 0; }
  return stmts.length;
}


/* ============================================================
   使いすぎを止める仕組み

   Google Cloud の予算アラートは「知らせる」だけで、止めてはくれない。
   そこで、こちら側で回数を数えて上限で打ち切る。
   金額ではなく回数で管理すれば、構造的に超えない。

   月あたりの上限（無料枠に収まる数）
     Places 検索  … 4,500 回（無料枠 5,000 の手前で止める）
     Vision 判定  … 900 枚（無料枠 1,000 の手前）
     Gemini       … 1,200 回
   ============================================================ */
/* 実際の単価（2026年時点）
     Places 検索  … 5.24円/回   ← 桁違いに高い。無料枠は月5,000回
     Vision       … 0.25円/回   ← 無料枠は月1,000回
     Gemini       … 約0.05円/回

   無料枠を超えた瞬間から実費になるので、手前でしっかり止める。 */
const LIMITS = { gsearch: 400, vision: 300, gemini: 800 };

/* 1人あたりの1日の上限。誰か一人が使い切らないように */
const DAILY_PER_USER = { gsearch: 20, vision: 30, gemini: 40 };

function monthKey() {
  const d = new Date();
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

/** 1回ぶん使う。全体の上限か、その人の1日の上限を超えていたら false */
async function useQuota(env, name, userId) {
  const k = "q_" + name + "_" + monthKey();
  try {
    // ① その人の1日の上限
    if (userId) {
      const dk = "d_" + name + "_" + userId + "_" + dayKey();
      const d = await env.DB.prepare("SELECT v FROM app_config WHERE k=?").bind(dk).first();
      const dUsed = d ? Number(d.v) || 0 : 0;
      if (dUsed >= (DAILY_PER_USER[name] || 0)) return false;
      await env.DB.prepare(
        "INSERT INTO app_config (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=?"
      ).bind(dk, String(dUsed + 1), String(dUsed + 1)).run();
    }
    // ② 全体の上限
    const r = await env.DB.prepare("SELECT v FROM app_config WHERE k=?").bind(k).first();
    const used = r ? Number(r.v) || 0 : 0;
    if (used >= (LIMITS[name] || 0)) return false;
    await env.DB.prepare(
      "INSERT INTO app_config (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=?"
    ).bind(k, String(used + 1), String(used + 1)).run();
    return true;
  } catch (e) {
    return false;   // 数えられないときは使わせない（安全側）
  }
}

const UNIT_YEN = { gsearch: 5.24, vision: 0.25, gemini: 0.05 };

async function quotaState(env) {
  const out = {};
  let total = 0;
  for (const name of Object.keys(LIMITS)) {
    try {
      const r = await env.DB.prepare("SELECT v FROM app_config WHERE k=?")
        .bind("q_" + name + "_" + monthKey()).first();
      const used = r ? Number(r.v) || 0 : 0;
      const yen = Math.round(used * (UNIT_YEN[name] || 0));
      total += yen;
      out[name] = { used, limit: LIMITS[name], yen };
    } catch (e) { out[name] = { used: -1, limit: LIMITS[name] }; }
  }
  out.合計円 = total;
  return out;
}


/* ============================================================
   写真を見て判断する

   ① 安全確認（Vision）… 不適切な画像を弾く。公開する以上、必須
   ② ひとことの提案（Gemini）… 「何を食べた？」の候補を出す

   どちらも回数の上限つき。超えたら黙って何もしない。
   ============================================================ */

const VISION = "https://vision.googleapis.com/v1/images:annotate";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

/** 写真が出しても大丈夫かを確かめる */
async function vision(request, env, me) {
  const key = await cfg(env, "google_key");
  if (!key) return json({ ok: true, skipped: "キー未設定" });

  const b = await request.json();
  const img = String(b.image || "").replace(/^data:image\/\w+;base64,/, "");
  if (!img) return json({ error: "画像が必要です" }, 400);

  if (!(await useQuota(env, "vision", me && me.id))) return json({ ok: true, skipped: "上限" });

  const res = await fetch(VISION + "?key=" + encodeURIComponent(key), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{
        image: { content: img },
        // 安全確認だけにする。内容の判定は使っていないのに、
        // 一緒に要求すると倍の料金がかかっていた
        features: [{ type: "SAFE_SEARCH_DETECTION" }]
      }]
    })
  });

  if (!res.ok) return json({ ok: true, skipped: "HTTP " + res.status });
  const j = await res.json();
  const r = (j.responses && j.responses[0]) || {};
  const ss = r.safeSearchAnnotation || {};

  const bad = ["LIKELY", "VERY_LIKELY"];
  const ng = bad.includes(ss.adult) || bad.includes(ss.violence) ||
             bad.includes(ss.racy) || bad.includes(ss.medical);

  const labels = (r.labelAnnotations || []).map(function (x) { return x.description; });

  return json({ ok: !ng, reason: ng ? "不適切な内容の可能性" : null, labels: labels });
}

/** 写真を見て、ひとことの候補を出す */
async function suggest(request, env, me) {
  const key = await cfg(env, "google_key");
  if (!key) return json({ items: [] });

  const b = await request.json();
  const img = String(b.image || "").replace(/^data:image\/\w+;base64,/, "");
  if (!img) return json({ items: [] });

  if (!(await useQuota(env, "gemini", me && me.id))) return json({ items: [] });

  const cat = String(b.category || "");
  const ask = (cat === "景" || cat === "社" || cat === "園")
    ? "この写真をどう撮ったかを短く言い表す言葉を3つ。例：夕方、対岸から／桜、朝いちばん"
    : "この写真に写っている料理や飲みものの名前を3つ。例：味玉らーめん／クリームソーダ";

  const res = await fetch(GEMINI + "?key=" + encodeURIComponent(key), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: ask + "\n日本語で、それぞれ12文字以内。JSONの配列だけを返してください。説明は不要です。" },
          { inline_data: { mime_type: "image/jpeg", data: img } }
        ]
      }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 120 }
    })
  });

  if (!res.ok) return json({ items: [] });
  const j = await res.json();
  let text = "";
  try {
    text = j.candidates[0].content.parts[0].text || "";
  } catch (e) { return json({ items: [] }); }

  text = text.replace(/```json|```/g, "").trim();
  let items = [];
  try { items = JSON.parse(text); } catch (e) {
    items = text.split(/[\n、,]/).map(function (s) { return s.trim(); });
  }
  items = (items || []).filter(function (s) {
    return typeof s === "string" && s.length > 0 && s.length <= 16;
  }).slice(0, 3);

  return json({ items: items });
}


/** 通知の宛先を預かる */
async function saveToken(request, env, me) {
  const b = await request.json();
  const t = String(b.token || "").trim();
  if (!t) return json({ error: "宛先が必要です" }, 400);
  await env.DB.prepare(`
    INSERT INTO push_tokens (token, user_id, platform, updated_at)
    VALUES (?,?,?,?)
    ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id, updated_at=excluded.updated_at
  `).bind(t, me.id, b.platform || "ios", Date.now()).run();
  return json({ ok: true });
}


/* ============================================================
   通知を送る

   Firebase を通してiPhoneへ届ける。
   送るときに音の名前を指定すると、その音で鳴る。
   （音のファイルはアプリの中に入れておく）
   ============================================================ */

const SOUND = "spota.caf";     // アプリに入れた音の名前

/** Firebase に話しかけるための証をつくる */
async function fcmToken(env) {
  const raw = await cfg(env, "fcm_service_account");
  if (!raw) return null;

  let sa;
  try { sa = JSON.parse(raw); } catch (e) { return null; }

  const now = Math.floor(Date.now() / 1000);
  const head = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };

  const b64 = function (o) {
    return btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const unsigned = b64(head) + "." + b64(claim);

  // 鍵を読み込んで署名する
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const bin = atob(pem);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);

  const key = await crypto.subtle.importKey(
    "pkcs8", buf.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)
  );
  const sigB64 = btoa(String.fromCharCode.apply(null, new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" +
          unsigned + "." + sigB64
  });
  if (!res.ok) return null;
  const j = await res.json();
  return { token: j.access_token, project: sa.project_id };
}

/** ある人に通知を届ける */
async function sendPush(env, userId, title, body, data) {
  const auth = await fcmToken(env);
  if (!auth) return 0;

  const rows = await env.DB
    .prepare("SELECT token FROM push_tokens WHERE user_id=?").bind(userId).all();
  const tokens = (rows.results || []).map(function (r) { return r.token; });
  if (!tokens.length) return 0;

  let sent = 0;
  for (const t of tokens) {
    const msg = {
      message: {
        token: t,
        notification: { title: title, body: body },
        data: data || {},
        apns: {
          payload: {
            aps: { sound: SOUND, badge: 1 }
          }
        }
      }
    };
    try {
      const r = await fetch(
        "https://fcm.googleapis.com/v1/projects/" + auth.project + "/messages:send",
        {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + auth.token,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(msg)
        }
      );
      if (r.ok) sent++;
      else if (r.status === 404) {
        // その宛先はもう使えない
        await env.DB.prepare("DELETE FROM push_tokens WHERE token=?").bind(t).run();
      }
    } catch (e) {}
  }
  return sent;
}

/** 自分に試しに送る */
async function pushTest(env, me) {
  const n = await sendPush(env, me.id, "spota", "通知はこの音で届きます", { test: "1" });
  return json({ sent: n });
}


/* ============================================================
   タグ付け

   一緒にいた人を選ぶと、その人に知らせが飛ぶ。
   受け取った人は「自分の思い出にする」を押すだけで、
   同じ写真・同じ場所が自分の地図にも載る。

   勝手に相手の地図へ載せることはしない。
   受け取るかどうかは、必ず本人が決める。
   ============================================================ */

async function addTags(request, env, me) {
  const b = await request.json();
  const postId = String(b.post_id || "");
  const ids = (b.user_ids || []).slice(0, 20);
  if (!postId || !ids.length) return json({ error: "指定が足りません" }, 400);

  const own = await env.DB.prepare("SELECT * FROM posts WHERE id=? AND user_id=?")
    .bind(postId, me.id).first();
  if (!own) return json({ error: "権限がありません" }, 403);

  const now = Date.now();
  const who = me.display_name || me.handle || "フレンド";
  let n = 0;

  for (const uid of ids) {
    // フレンドでない相手には付けられない
    if (!(await areFriends(env, me.id, uid))) continue;
    if (await isBlocked(env, me.id, uid)) continue;

    await env.DB.prepare(`
      INSERT INTO post_tags (post_id, user_id, tagged_by, status, created_at)
      VALUES (?,?,?, 'pending', ?)
      ON CONFLICT(post_id, user_id) DO NOTHING
    `).bind(postId, uid, me.id, now).run();

    await sendPush(env, uid, who + " が思い出にタグ付けしました",
      own.title || own.place_name || "",
      { lat: String(own.lat), lng: String(own.lng), post: postId, tag: "1" });
    n++;
  }
  return json({ ok: true, count: n });
}

/** 自分に付いた、まだ返事をしていないもの */
async function myTags(env, me) {
  const rows = await env.DB.prepare(`
    SELECT t.post_id, t.created_at,
           p.title, p.category, p.tag, p.place_name, p.lat, p.lng, p.taken_at,
           u.display_name, u.handle, u.id AS from_id
      FROM post_tags t
      JOIN posts p ON p.id = t.post_id AND p.deleted_at IS NULL
      JOIN users u ON u.id = t.tagged_by
     WHERE t.user_id = ? AND t.status = 'pending'
     ORDER BY t.created_at DESC
     LIMIT 30
  `).bind(me.id).all();

  const out = [];
  for (const r of (rows.results || [])) {
    const ph = await env.DB.prepare(
      "SELECT id FROM photos WHERE post_id=? ORDER BY sort_order LIMIT 1"
    ).bind(r.post_id).first();
    out.push({
      post_id: r.post_id, title: r.title, category: r.category,
      tag: r.tag, place_name: r.place_name,
      lat: r.lat, lng: r.lng, taken_at: r.taken_at,
      photo_id: ph ? ph.id : null,
      from: { id: r.from_id, name: r.display_name || r.handle || "" }
    });
  }
  return json({ count: out.length, tags: out });
}

/** 「自分の思い出にする」を押したとき。写真ごと自分のものとして作る */
async function takeTag(request, env, me) {
  const b = await request.json();
  const postId = String(b.post_id || "");
  const take = b.take !== false;

  const t = await env.DB.prepare(
    "SELECT * FROM post_tags WHERE post_id=? AND user_id=? AND status='pending'"
  ).bind(postId, me.id).first();
  if (!t) return json({ error: "見つかりません" }, 404);

  if (!take) {
    await env.DB.prepare(
      "UPDATE post_tags SET status='declined' WHERE post_id=? AND user_id=?"
    ).bind(postId, me.id).run();
    return json({ ok: true, taken: false });
  }

  const src = await env.DB.prepare("SELECT * FROM posts WHERE id=? AND deleted_at IS NULL")
    .bind(postId).first();
  if (!src) return json({ error: "元の思い出がありません" }, 404);

  const now = Date.now();
  const newId = uuid();

  await env.DB.prepare(`
    INSERT INTO posts (
      id,user_id,place_id,title,category,tag,place_name,body,
      lat,lng,approx_lat,approx_lng,area_lat,area_lng,
      taken_at,created_at,visibility,publish_at
    ) VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)
  `).bind(
    newId, me.id, src.place_id, src.title, src.category, src.tag,
    src.place_name, src.body,
    src.lat, src.lng, src.approx_lat, src.approx_lng, src.area_lat, src.area_lng,
    src.taken_at, now, me.default_visibility || "friends",
    now + (me.publish_delay_sec || 0) * 1000
  ).run();

  // 写真は同じものを指す。ここで複製すると容量が倍になる
  const phs = await env.DB.prepare("SELECT * FROM photos WHERE post_id=?")
    .bind(postId).all();
  for (const ph of (phs.results || [])) {
    await env.DB.prepare(`
      INSERT INTO photos (id,post_id,user_id,key_orig,key_view,key_thumb,
                          width,height,sort_order,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).bind(uuid(), newId, me.id, ph.key_orig, ph.key_view, ph.key_thumb,
            ph.width, ph.height, ph.sort_order, now).run();
  }

  await env.DB.prepare(
    "UPDATE post_tags SET status='accepted', new_post_id=? WHERE post_id=? AND user_id=?"
  ).bind(newId, postId, me.id).run();

  return json({ ok: true, taken: true, id: newId });
}


/* ============================================================
   Wikipedia

   ブラウザから直接叩くと、こちらの名乗り（User-Agent）を付けられない。
   2026年の規約変更で、名乗りのないリクエストは
   予告なくブロックされることになった。

   そこでサーバーを通し、
   ・連絡先つきの名乗りを付ける
   ・結果を1日残して、同じ場所を何度も叩かない
   ・呼び出しの回数を数える
   の3つを守る。
   ============================================================ */

/* 記事の分類から、どういう場所かを見分ける */
function wikiCat(s) {
  s = String(s || "");
  if (/温泉|銭湯|浴場/.test(s)) return "湯";
  if (/神社|寺院|寺|大社|神宮|仏閣/.test(s)) return "社";
  if (/公園|庭園|植物園|渓谷|滝|湖沼/.test(s)) return "園";
  if (/図書館|書店/.test(s)) return "本";
  return "景";
}

const WIKI_UA = "spota/1.0 (https://broad-wildflower-9e30.j4hrd7zdgc.workers.dev)";

async function wiki(url, env) {
  const mode = url.searchParams.get("mode") || "near";

  if (mode === "near") return wikiNear(url, env);
  if (mode === "views") return wikiViews(url, env);
  return json({ error: "mode が不正です" }, 400);
}

/** この辺りの記事を返す。座標・説明・分類・画像つき */
async function wikiNear(url, env) {
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!isFinite(lat) || !isFinite(lng)) return json({ error: "lat / lng が必要です" }, 400);

  let rad = Number(url.searchParams.get("radius") || 3000);
  rad = Math.min(10000, Math.max(500, rad));

  // 同じあたりは1日に1度だけ取りに行く
  const cell = lat.toFixed(2) + "," + lng.toFixed(2) + "," + Math.round(rad / 1000);
  const ck = "wiki_" + cell;
  const cached = await cacheGet(env, ck, 86400);
  if (cached) return json(Object.assign({ cached: true }, cached));

  const api = new URL("https://ja.wikipedia.org/w/api.php");
  api.searchParams.set("action", "query");
  api.searchParams.set("format", "json");
  api.searchParams.set("formatversion", "2");
  api.searchParams.set("generator", "geosearch");
  api.searchParams.set("ggscoord", lat.toFixed(6) + "|" + lng.toFixed(6));
  api.searchParams.set("ggsradius", String(rad));
  api.searchParams.set("ggslimit", "60");
  api.searchParams.set("prop", "coordinates|description|pageimages|categories");
  api.searchParams.set("cllimit", "30");
  api.searchParams.set("clshow", "!hidden");
  api.searchParams.set("piprop", "thumbnail");
  api.searchParams.set("pithumbsize", "320");

  const res = await fetch(api.toString(), {
    headers: { "User-Agent": WIKI_UA, "Accept": "application/json" },
    cf: { cacheTtl: 86400, cacheEverything: true }
  });
  if (!res.ok) {
    if (res.status === 429) return json({ error: "混みあっています", pages: [] }, 200);
    return json({ error: "Wikipedia HTTP " + res.status, pages: [] }, 200);
  }

  const j = await res.json();
  const pages = ((j.query && j.query.pages) || []).map(function (p) {
    const co = (p.coordinates && p.coordinates[0]) || null;
    if (!co) return null;
    return {
      title: p.title,
      lat: co.lat, lng: co.lon,
      desc: p.description || "",
      photo: p.thumbnail ? p.thumbnail.source : "",
      cats: (p.categories || []).map(function (c) {
        return String(c.title || "").replace(/^Category:/, "");
      })
    };
  }).filter(Boolean);

  const out = { count: pages.length, pages };
  await cacheSet(env, ck, out);

  // 取ってきたものは、こちらの場所マスタにも残す。
  // 貯まるほど、外へ取りに行く回数が減る
  await savePlaces(env, pages.map(function (p) {
    return {
      n: p.title, lat: p.lat, lng: p.lng,
      c: wikiCat(p.title + " " + p.desc + " " + p.cats.join(" ")),
      src: "user", sid: "wk_" + p.title,
      gname: p.desc || null
    };
  }));

  return json(out);
}

/** 記事ごとの、直近7日の閲覧数 */
async function wikiViews(url, env) {
  const titles = (url.searchParams.get("titles") || "").split("|")
    .map(function (s) { return s.trim(); })
    .filter(Boolean).slice(0, 15);
  if (!titles.length) return json({ views: {} });

  const end = new Date(Date.now() - 86400000);
  const start = new Date(end.getTime() - 6 * 86400000);
  const fmt = function (d) { return d.toISOString().slice(0, 10).replace(/-/g, "") + "00"; };
  const span = fmt(start) + "/" + fmt(end);

  const views = {};
  const todo = [];
  for (const t of titles) {
    const c = await cacheGet(env, "pv_" + span + "_" + t, 86400);
    if (c) views[t] = c.v; else todo.push(t);
  }

  // 残りを取りに行く。同時に投げず、順に
  for (const t of todo) {
    try {
      const u = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/" +
        "ja.wikipedia/all-access/user/" +
        encodeURIComponent(t.replace(/ /g, "_")) + "/daily/" + span;
      const r = await fetch(u, {
        headers: { "User-Agent": WIKI_UA },
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
      if (!r.ok) { views[t] = 0; continue; }
      const jj = await r.json();
      let sum = 0;
      (jj.items || []).forEach(function (x) { sum += x.views || 0; });
      views[t] = sum;
      await cacheSet(env, "pv_" + span + "_" + t, { v: sum });
    } catch (e) { views[t] = 0; }
  }

  return json({ views });
}

/* ---- 取ってきたものを残しておく仕組み ---- */
async function cacheGet(env, key, maxAgeSec) {
  try {
    const r = await env.DB.prepare("SELECT v, at FROM api_cache WHERE k=?").bind(key).first();
    if (!r) return null;
    if (Date.now() - r.at > maxAgeSec * 1000) return null;
    return JSON.parse(r.v);
  } catch (e) { return null; }
}
async function cacheSet(env, key, obj) {
  try {
    await env.DB.prepare(
      "INSERT INTO api_cache (k,v,at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=?, at=?"
    ).bind(key, JSON.stringify(obj), Date.now(), JSON.stringify(obj), Date.now()).run();
  } catch (e) {}
}
