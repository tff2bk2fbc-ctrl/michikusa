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
      const h = new Headers(res.headers);
      if (ct.includes("text/html")) {
        h.set("Cache-Control", "no-cache, no-store, must-revalidate");
        h.set("Content-Security-Policy", [
          "default-src 'self'",
          "script-src 'self' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://www.gstatic.com",
          "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
          "img-src 'self' data: blob: https:",
          "connect-src 'self' https:",
          "font-src 'self' data: https:",
          "worker-src 'self' blob:",
          "frame-src https://*.firebaseapp.com https://accounts.google.com",
          "object-src 'none'",
          "base-uri 'self'",
          "frame-ancestors 'none'"
        ].join("; "));
      }
      return secure(new Response(res.body, { status: res.status, headers: h }));
    }

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    try {
      if (p === "/api/health") {
        return cors(json({
          ok: true,
          build: "api-27"
        }));
      }
      if (p === "/api/hotpepper") return cors(await hotpepper(url, request, env));
      if (p === "/api/rakuten")   return cors(await rakuten(url, request, env));
      if (p === "/api/places")    return cors(await nearbyPlaces(url, env));
      if (p === "/api/geocode")   return cors(await geocode(url, request, env));
      if (p === "/api/reverse")   return cors(await reverseGeocode(url, request, env));
      if (p === "/api/wiki")      return cors(await wiki(url, request, env));
      if (p === "/api/img")       return secure(await proxyImage(url, request, env));

      // ---- ここから先はログインが必要 ----
      const me = await authenticate(request, env);
      if (!me) return cors(json({ error: "ログインが必要です" }, 401));

      // 外部の有料APIと、ユーザーに紐づく通知・タグ操作は必ず認証後に置く。
      if (p === "/api/gsearch")   return cors(await gsearch(url, env, me));
      if (p === "/api/vision" && request.method === "POST") return cors(await vision(request, env, me));
      if (p === "/api/suggest" && request.method === "POST") return cors(await suggest(request, env, me));
      if (p === "/api/push/token" && request.method === "POST") return cors(await saveToken(request, env, me));
      if (p === "/api/push/test"  && request.method === "POST") return cors(await pushTest(env, me));
      if (p === "/api/tags" && request.method === "POST")  return cors(await addTags(request, env, me));
      if (p === "/api/tags" && request.method === "GET")   return cors(await myTags(env, me));
      if (p === "/api/tags/accept" && request.method === "POST") return cors(await takeTag(request, env, me));

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
      // DB名や外部APIの詳細を利用者へ返さない。
      console.error("api error", e);
      return cors(json({ error: "サーバー内エラー" }, 500));
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
  const parsed = await limitedJson(request, 24_000);
  if (parsed.error) return parsed.error;
  const b = parsed.value;
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!validCoords(lat, lng)) return json({ error: "位置が不正です" }, 400);

  const title = limitedText(b.title, 120);
  const category = limitedText(b.category || "景", 16);
  const tag = limitedText(b.tag, 80);
  const placeName = limitedText(b.place_name, 160);
  const body = limitedText(b.body, 4000);
  const placeIdText = limitedText(b.place_id, 200);
  const placeId = placeIdText || null;
  if ([title, category, tag, placeName, body, placeIdText].includes(null)) {
    return json({ error: "投稿の文字数が上限を超えています" }, 413);
  }

  let fixedLat = null, fixedLng = null, fixedLabel = null;
  if (b.fixed_lat != null || b.fixed_lng != null) {
    fixedLat = Number(b.fixed_lat);
    fixedLng = Number(b.fixed_lng);
    fixedLabel = limitedText(b.fixed_label, 160);
    if (!validCoords(fixedLat, fixedLng) || fixedLabel === null) {
      return json({ error: "固定位置が不正です" }, 400);
    }
  }

  if (!(await userLimit(env, me.id, "posts-hour", hourKey(), 30)) ||
      !(await userLimit(env, me.id, "posts-day", dayKey(), 200))) {
    return json({ error: "投稿回数が多すぎます。しばらく待ってください" }, 429);
  }

  const now = Date.now();
  const vis = ["private", "friends", "public"].includes(b.visibility)
    ? b.visibility
    : (["private", "friends", "public"].includes(me.default_visibility) ? me.default_visibility : "private");

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
    id, me.id, placeId, title || "", category || "景",
    tag || "", placeName || "", body || "",
    lat, lng, aLat, aLng, rLat, rLng,
    fixedLat, fixedLng, fixedLabel,
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
          title || placeName || "", { post: id });
      }
    } catch (e) {}
  }

  return json({ id, visibility: vis });
}

async function patchPost(id, request, env, me) {
  const parsed = await limitedJson(request, 16_000);
  if (parsed.error) return parsed.error;
  const b = parsed.value;
  const own = await env.DB.prepare("SELECT user_id,visibility FROM posts WHERE id=?").bind(id).first();
  if (!own || own.user_id !== me.id) return json({ error: "権限がありません" }, 403);

  if (!(await userLimit(env, me.id, "post-edits-hour", hourKey(), 60))) {
    return json({ error: "更新回数が多すぎます。しばらく待ってください" }, 429);
  }

  const sets = [], vals = [];
  if (["private", "friends", "public"].includes(b.visibility)) {
    if (b.visibility !== "private" && !(await ensurePostPhotosModerated(env, me, id))) {
      return json({ error: "画像の安全確認が完了していないため公開できません" }, 409);
    }
    sets.push("visibility=?"); vals.push(b.visibility);
  }
  const textLimits = { title: 120, tag: 80, category: 16, body: 4000 };
  for (const k of Object.keys(textLimits)) {
    if (!(k in b)) continue;
    const v = limitedText(b[k], textLimits[k]);
    if (v === null) return json({ error: k + " の文字数が上限を超えています" }, 413);
    sets.push(k + "=?"); vals.push(v);
  }
  if ("fixed_lat" in b) {
    const fLat = Number(b.fixed_lat), fLng = Number(b.fixed_lng);
    const fLabel = limitedText(b.fixed_label, 160);
    if (!validCoords(fLat, fLng) || fLabel === null) {
      return json({ error: "固定位置が不正です" }, 400);
    }
    sets.push("fixed_lat=?", "fixed_lng=?", "fixed_label=?");
    vals.push(fLat, fLng, fLabel || null);
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
  const postId = String(url.searchParams.get("post_id") || "");
  const kind = url.searchParams.get("kind");            // orig / view / thumb
  if (!["orig", "view", "thumb"].includes(kind)) return json({ error: "kind が不正です" }, 400);

  const own = await env.DB.prepare(
    "SELECT user_id, visibility FROM posts WHERE id=? AND deleted_at IS NULL"
  ).bind(postId).first();
  if (!own || own.user_id !== me.id) return json({ error: "権限がありません" }, 403);

  const requestedId = String(url.searchParams.get("photo_id") || "");
  if (requestedId && !/^[A-Za-z0-9_-]{8,80}$/.test(requestedId)) {
    return json({ error: "photo_id が不正です" }, 400);
  }
  const photoId = requestedId || uuid();
  const exists = await env.DB.prepare(
    "SELECT id,user_id,post_id FROM photos WHERE id=?"
  ).bind(photoId).first();
  // クライアント採番との互換性は残すが、既存IDの更新は所有者と投稿を厳格に照合する。
  if (exists && (exists.user_id !== me.id || exists.post_id !== postId)) {
    return json({ error: "その写真IDは使用できません" }, 409);
  }

  const ct = (request.headers.get("Content-Type") || "").split(";")[0].toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(ct)) {
    return json({ error: "対応していない画像形式です" }, 415);
  }
  const maxBytes = kind === "orig" ? 25_000_000 : kind === "view" ? 8_000_000 : 1_500_000;
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) return json({ error: "画像が大きすぎます" }, 413);
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > maxBytes) {
    return json({ error: "画像サイズが不正です" }, 413);
  }
  if (!validImageBytes(bytes, ct)) {
    return json({ error: "画像の内容と形式が一致しません" }, 415);
  }

  if (!exists) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM photos WHERE post_id=?")
      .bind(postId).first();
    if ((Number(count && count.n) || 0) >= 12) return json({ error: "写真は12枚までです" }, 409);
  }
  if (!(await userLimit(env, me.id, "photo-requests-hour", hourKey(), 80)) ||
      !(await userLimit(env, me.id, "photo-bytes-day", dayKey(), 300_000_000, bytes.byteLength)) ||
      !(await userLimit(env, me.id, "photo-bytes-total", "all", 5_000_000_000, bytes.byteLength))) {
    return json({ error: "画像の利用上限に達しました" }, 429);
  }

  let moderation = "not-required";
  if (own.visibility !== "private") {
    moderation = await moderateUploadedPhoto(env, me, bytes);
    if (moderation !== "ok") {
      // 判定不能も公開しない。画像自体は本人の非公開記録として保存できる。
      await env.DB.prepare("UPDATE posts SET visibility='private' WHERE id=? AND user_id=?")
        .bind(postId, me.id).run();
    }
  }

  const key = `u/${me.id}/${postId}/${photoId}-${kind}.jpg`;

  await env.PHOTOS.put(key, bytes, {
    httpMetadata: { contentType: ct }
  });

  const col = kind === "orig" ? "key_orig" : kind === "view" ? "key_view" : "key_thumb";
  if (exists) {
    await env.DB.prepare(
      `UPDATE photos SET ${col}=? WHERE id=? AND user_id=? AND post_id=?`
    ).bind(key, photoId, me.id, postId).run();
  } else {
    try {
      await env.DB.prepare(
        `INSERT INTO photos (id,post_id,user_id,${col},created_at) VALUES (?,?,?,?,?)`
      ).bind(photoId, postId, me.id, key, Date.now()).run();
    } catch (e) {
      // DBへ参照を残せなかった新規オブジェクトは、その場で回収する。
      await env.PHOTOS.delete(key);
      throw e;
    }
  }
  if (own.visibility !== "private" && moderation !== "ok") {
    // 並行PATCHとの競合後も、判定不能な画像を公開状態に残さない。
    await env.DB.prepare("UPDATE posts SET visibility='private' WHERE id=? AND user_id=?")
      .bind(postId, me.id).run();
  }
  return json({ photo_id: photoId, kind, moderation });
}

/** GET /api/photo/{photoId}/{kind} — 見てよい相手かを必ず確かめてから返す */
async function getPhoto(path, env, me) {
  const [, , , photoId, kind] = path.split("/");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(photoId || "") ||
      !["orig", "view", "thumb"].includes(kind)) {
    return json({ error: "見つかりません" }, 404);
  }
  const ph = await env.DB.prepare("SELECT * FROM photos WHERE id=?").bind(photoId).first();
  if (!ph) return json({ error: "見つかりません" }, 404);

  const post = await env.DB.prepare("SELECT * FROM posts WHERE id=? AND deleted_at IS NULL")
    .bind(ph.post_id).first();
  if (!post) return json({ error: "見つかりません" }, 404);

  // 原本にはEXIF位置情報が残り得る。実際にアップロードした本人だけへ返す。
  if (kind === "orig" && !String(ph.key_orig || "").startsWith(`u/${me.id}/`)) {
    return json({ error: "権限がありません" }, 403);
  }

  if (post.user_id !== me.id) {
    if (post.publish_at > Date.now() || post.visibility === "private") {
      return json({ error: "権限がありません" }, 403);
    }
    const tagged = await env.DB.prepare(
      "SELECT 1 FROM post_tags WHERE post_id=? AND user_id=? AND status IN ('pending','accepted')"
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

async function hotpepper(url, request, env) {
  const got = await getHpKey(env);
  const key = got.key;
  if (!key) return json({ error: "ホットペッパーのキーが見つかりません（envにもD1にもありません）" }, 500);

  const lat = url.searchParams.get("lat"), lng = url.searchParams.get("lng");
  const range = url.searchParams.get("range") || "5";
  const keyword = url.searchParams.get("keyword") || "";
  if (keyword.length > 120 || !/^[1-5]$/.test(range)) {
    return json({ error: "検索条件が不正です" }, 400);
  }
  // キーワード検索のときは位置が無くてもよい（全国から探す）
  if (!keyword && (!lat || !lng)) return json({ error: "lat / lng が必要です" }, 400);
  if ((lat || lng) && !validCoords(Number(lat), Number(lng))) {
    return json({ error: "位置が不正です" }, 400);
  }
  if (!(await publicAllowance(request, env, "hotpepper", 120, 500))) {
    return json({ error: "検索回数が多すぎます" }, 429);
  }

  const shops = [];
  let available = 0;
  const pages = Math.min(3, Math.max(1, Number.parseInt(url.searchParams.get("pages") || "2", 10) || 2));

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

function limitedText(value, max) {
  const s = String(value == null ? "" : value).trim();
  return s.length <= max ? s : null;
}

function validCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/** Content-Typeの申告だけでなく、代表的な画像シグネチャも確認する。 */
function validImageBytes(buffer, contentType) {
  const b = new Uint8Array(buffer);
  if (contentType === "image/jpeg") return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (contentType === "image/png") return b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
  if (contentType === "image/webp") return b.length >= 12 &&
    String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.slice(8, 12)) === "WEBP";
  if (contentType === "image/heic" || contentType === "image/heif") {
    return b.length >= 12 && String.fromCharCode(...b.slice(4, 8)) === "ftyp";
  }
  return false;
}

/** Content-Length が無い場合も、実際に読んだUTF-8バイト数で制限する。 */
async function limitedJson(request, maxBytes) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) return { error: json({ error: "入力が大きすぎます" }, 413) };
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return { error: json({ error: "入力が大きすぎます" }, 413) };
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return { value };
  } catch (e) {
    return { error: json({ error: "JSONが不正です" }, 400) };
  }
}

function hourKey() {
  return new Date().toISOString().slice(0, 13);
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * D1の1文だけで加算と上限判定を行う。同時リクエストでも読み取り→更新の隙間を作らない。
 * app_config が使えない場合は、安全側へ倒して利用を止める。
 */
async function atomicLimit(env, key, limit, amount) {
  amount = Number(amount || 1);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > limit) return false;
  try {
    const r = await env.DB.prepare(`
      INSERT INTO app_config (k,v) VALUES (?,?)
      ON CONFLICT(k) DO UPDATE SET v=CAST(app_config.v AS INTEGER)+?
       WHERE CAST(app_config.v AS INTEGER)+? <= ?
    `).bind(key, String(amount), amount, amount, limit).run();
    return !!(r.meta && r.meta.changes === 1);
  } catch (e) {
    return false;
  }
}

function userLimit(env, userId, name, window, limit, amount) {
  return atomicLimit(env, `ul_${name}_${window}_${userId}`, limit, amount || 1);
}

async function shortHash(value) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(buf).slice(0, 12))
    .map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
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
  return secure(new Response(res.body, { status: res.status, headers: h }));
}

/** HTMLだけでなくJS/CSS/画像/APIにも、安全な既定ヘッダーを付ける。 */
function secure(res) {
  const h = new Headers(res.headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "camera=(self), geolocation=(self), microphone=()");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
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

async function rakuten(url, request, env) {
  const id = await cfg(env, "rakuten_id");
  const ak = await cfg(env, "rakuten_key");
  if (!id) return json({ error: "楽天のアプリケーションIDが未設定です" }, 500);
  if (!ak) return json({ error: "楽天のアクセスキーが未設定です（rakuten_key）" }, 500);

  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!validCoords(lat, lng)) return json({ error: "lat / lng が必要です" }, 400);
  if (!(await publicAllowance(request, env, "rakuten", 60, 300))) {
    return json({ error: "検索回数が多すぎます" }, 429);
  }

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
    return json({ error: "楽天トラベルを利用できません" }, 502);
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

async function proxyImage(url, request, env) {
  const src = url.searchParams.get("u");
  if (!src) return new Response("u が必要です", { status: 400 });
  if (src.length > 2048) return new Response("URLが長すぎます", { status: 400 });

  let t;
  try { t = new URL(src); } catch (e) { return new Response("URLが不正です", { status: 400 }); }
  if (t.protocol !== "https:") return new Response("https だけです", { status: 400 });

  // 決めた場所からの画像だけ通す（何でも中継すると踏み台にされる）
  const okHost = IMG_OK.some(function (d) {
    return t.hostname === d || t.hostname.endsWith("." + d);
  });
  if (!okHost) return new Response("その場所は許可していません", { status: 403 });
  if (!(await publicAllowance(request, env, "image-proxy", 180, 1000))) {
    return new Response("利用回数が多すぎます", { status: 429 });
  }

  const res = await fetch(t.toString(), {
    cf: { cacheTtl: 86400, cacheEverything: true },
    headers: { "User-Agent": "michikusa/1.0" }
  });
  if (!res.ok) return new Response("取得できません " + res.status, { status: 502 });

  const ct = (res.headers.get("Content-Type") || "").split(";")[0].toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"].includes(ct)) {
    return new Response("対応していない画像です", { status: 415 });
  }
  const declared = Number(res.headers.get("Content-Length") || 0);
  if (declared > 10_000_000) return new Response("画像が大きすぎます", { status: 413 });
  const bytes = await res.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 10_000_000) {
    return new Response("画像サイズが不正です", { status: 413 });
  }

  return new Response(bytes, {
    headers: {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=604800",
      "Access-Control-Allow-Origin": "*"
    }
  });
}


/* ============================================================
   地名検索 / 逆引き（Nominatim 中継）

   ブラウザから第三者へ検索語や写真位置を直接送らず、固定した上流だけを使う。
   同じ問い合わせはエッジキャッシュし、未キャッシュ時は利用者・全体の両方を制限する。
   ============================================================ */
const NOMINATIM = "https://nominatim.openstreetmap.org";
const NOMINATIM_UA = "Spota/1.0 (+https://broad-wildflower-9e30.j4hrd7zdgc.workers.dev)";

async function clientRateId(request) {
  // IPそのものはD1へ残さず、短い一方向ハッシュだけを回数キーに使う。
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return "client-" + await shortHash(ip);
}

async function publicAllowance(request, env, name, hourly, daily) {
  const client = await clientRateId(request);
  return (await userLimit(env, client, name + "-hour", hourKey(), hourly)) &&
    (await userLimit(env, client, name + "-day", dayKey(), daily));
}

async function nominatimAllowance(request, env, name, hourly) {
  const client = await clientRateId(request);
  if (!(await userLimit(env, client, "nominatim-" + name, hourKey(), hourly))) return false;
  // 公開サービスの利用規約に合わせ、キャッシュミスはアプリ全体で毎秒1回まで。
  if (!(await atomicLimit(env, "nom_sec_" + new Date().toISOString().slice(0, 19), 1, 1))) return false;
  return atomicLimit(env, "nom_day_" + dayKey(), 5000, 1);
}

async function cachedNominatim(cacheKey, ttl, load) {
  const cache = caches.default;
  const req = new Request("https://spota-cache.invalid/" + cacheKey);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await load();
  if (res.ok) {
    const h = new Headers(res.headers);
    h.set("Cache-Control", "public, max-age=" + ttl);
    const cached = new Response(res.body, { status: res.status, headers: h });
    await cache.put(req, cached.clone());
    return cached;
  }
  return res;
}

async function geocode(url, request, env) {
  if (request.method !== "GET") return json({ error: "GETだけです" }, 405);
  const q = String(url.searchParams.get("q") || "").trim();
  if (!q || q.length > 120 || /[\u0000-\u001f]/.test(q)) {
    return json({ error: "検索語が不正です" }, 400);
  }
  const limit = Math.min(4, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "4", 10) || 4));
  const key = "geocode?q=" + encodeURIComponent(q.toLocaleLowerCase("ja")) + "&limit=" + limit;
  return cachedNominatim(key, 86400, async function () {
    if (!(await nominatimAllowance(request, env, "search", 40))) {
      return json({ error: "地名検索が混み合っています" }, 429);
    }
    const up = new URL(NOMINATIM + "/search");
    up.searchParams.set("q", q);
    up.searchParams.set("format", "jsonv2");
    up.searchParams.set("addressdetails", "1");
    up.searchParams.set("accept-language", "ja");
    up.searchParams.set("countrycodes", "jp");
    up.searchParams.set("limit", String(limit));
    const r = await fetch(up, { headers: { "User-Agent": NOMINATIM_UA, "Accept": "application/json" } });
    if (!r.ok) return json({ error: "地名検索を利用できません" }, 502);
    const rows = await r.json();
    const places = (Array.isArray(rows) ? rows : []).slice(0, limit).map(function (p) {
      const lat = Number(p.lat), lng = Number(p.lon);
      if (!validCoords(lat, lng)) return null;
      return {
        name: limitedText(p.name || String(p.display_name || "").split(",")[0], 160) || "",
        display_name: limitedText(p.display_name, 500) || "",
        lat: String(lat), lon: String(lng), lng: String(lng),
        type: limitedText(p.type, 80) || ""
      };
    }).filter(Boolean);
    return json({ places });
  });
}

async function reverseGeocode(url, request, env) {
  if (request.method !== "GET") return json({ error: "GETだけです" }, 405);
  let lat = Number(url.searchParams.get("lat"));
  let lng = Number(url.searchParams.get("lng"));
  if (!validCoords(lat, lng)) return json({ error: "位置が不正です" }, 400);
  // 約11m単位へ丸め、端末由来の過剰に細かい座標を第三者へ渡さない。
  lat = Math.round(lat * 10_000) / 10_000;
  lng = Math.round(lng * 10_000) / 10_000;
  const zoom = Math.min(18, Math.max(3, Number.parseInt(url.searchParams.get("zoom") || "18", 10) || 18));

  // 国交省データを入れたD1があれば最優先する。外部へ座標を送らず、地域を1つずつ
  // 追加できる。未接続・未収録地域だけ従来のNominatimへフォールバックする。
  const local = await reverseFromAddressDb(lat, lng, env);
  if (local) return json(local);

  const key = "reverse?lat=" + lat.toFixed(4) + "&lng=" + lng.toFixed(4) + "&zoom=" + zoom;
  return cachedNominatim(key, 604800, async function () {
    if (!(await nominatimAllowance(request, env, "reverse", 120))) {
      return json({ error: "地名検索が混み合っています" }, 429);
    }
    const up = new URL(NOMINATIM + "/reverse");
    up.searchParams.set("lat", lat.toFixed(4));
    up.searchParams.set("lon", lng.toFixed(4));
    up.searchParams.set("zoom", String(zoom));
    up.searchParams.set("format", "jsonv2");
    up.searchParams.set("addressdetails", "1");
    up.searchParams.set("accept-language", "ja");
    const r = await fetch(up, { headers: { "User-Agent": NOMINATIM_UA, "Accept": "application/json" } });
    if (!r.ok) return json({ error: "地名検索を利用できません" }, 502);
    const p = await r.json();
    const src = p && typeof p.address === "object" ? p.address : {};
    const address = {};
    for (const k of ["province", "state", "city", "town", "village", "county",
                     "city_district", "suburb", "neighbourhood", "quarter", "road"]) {
      const v = limitedText(src[k], 160);
      if (v) address[k] = v;
    }
    return json({
      name: limitedText(p && p.name, 160) || "",
      display_name: limitedText(p && p.display_name, 500) || "",
      address,
      lat: String(lat), lon: String(lng)
    });
  });
}

const ADDRESS_DB_BINDINGS = [
  "ADDR_HOKKAIDO", "ADDR_TOHOKU", "ADDR_TOKYO", "ADDR_SOUTH_KANTO",
  "ADDR_NORTH_KANTO", "ADDR_CHUBU", "ADDR_KINKI", "ADDR_CHUGOKU_SHIKOKU",
  "ADDR_KYUSHU_OKINAWA"
];

async function reverseFromAddressDb(lat, lng, env) {
  const databases = ADDRESS_DB_BINDINGS.map((name) => env[name]).filter(Boolean);
  if (!databases.length) return null;
  const latE6 = Math.round(lat * 1e6), lngE6 = Math.round(lng * 1e6);
  const admin = await findAdminArea(latE6, lngE6, databases);
  // 全国9地域すべてに行政区域テーブルがあり、どの面にも属さない場合は海上として扱う。
  // 隣接市区町村の代表点を誤って返さず、外部サービスにも座標を送らない。
  if (admin.complete && !admin.area) {
    return {
      name: "海上",
      display_name: "海上",
      address: {},
      lat: String(lat), lon: String(lng),
      source: "mlit-n03",
      offshore: true
    };
  }
  const gridLat = Math.floor(lat * 500), gridLng = Math.floor(lng * 500);
  const searchDatabases = admin.db ? [admin.db] : databases;
  // 街区代表点が疎い山間部・離島では、行政区域を固定したまま探索範囲だけを広げる。
  // 隣の市区町村へは越境しない。
  for (const radius of [1, 3, 10, 50, 250]) {
    const rows = await Promise.all(searchDatabases.map(async function (db) {
      try {
        const result = await db.prepare(`
          SELECT ap.lat_e6,ap.lng_e6,ap.block,
                 pr.name AS prefecture,mu.name AS municipality,
                 COALESCE(atr.official_name,t.name) AS town,t.locality,
                 atr.machiaza_id,atr.post_code
          FROM address_points ap
          JOIN address_towns t ON t.id=ap.town_id
          JOIN address_municipalities mu ON mu.id=t.municipality_id
          JOIN address_prefectures pr ON pr.id=mu.prefecture_id
          LEFT JOIN address_town_registry atr ON atr.town_id=t.id
          WHERE ap.grid_lat BETWEEN ? AND ? AND ap.grid_lng BETWEEN ? AND ?
            AND (? IS NULL OR (pr.name=? AND mu.name=?))
          ORDER BY ((ap.lat_e6-?)*(ap.lat_e6-?))+((ap.lng_e6-?)*(ap.lng_e6-?))
          LIMIT 64
        `).bind(gridLat - radius, gridLat + radius, gridLng - radius, gridLng + radius,
                admin.area ? admin.area.lg_code : null,
                admin.area ? admin.area.prefecture : "",
                admin.area ? admin.area.municipality : "",
                latE6, latE6, lngE6, lngE6).all();
        return result.results || [];
      } catch (error) {
        // 段階導入中に未初期化DBがあっても外部フォールバックを止めない。
        console.error("address db error", error);
        return [];
      }
    }));
    const candidates = rows.flat();
    if (!candidates.length) continue;
    let best = null, bestDistance = Infinity;
    for (const row of candidates) {
      const distance = geoDistanceMeters(latE6 / 1e6, lngE6 / 1e6, row.lat_e6 / 1e6, row.lng_e6 / 1e6);
      if (distance < bestDistance) { best = row; bestDistance = distance; }
    }
    if (!best) continue;
    const address = {
      state: best.prefecture,
      city: best.municipality,
      town: best.town
    };
    if (best.locality) address.neighbourhood = best.locality;
    const parts = [best.prefecture, best.municipality, best.town, best.locality, best.block].filter(Boolean);
    const nearby = await nearestLocalPlace(latE6, lngE6, admin.db || databases[0]);
    return {
      name: [best.town, best.locality, best.block].filter(Boolean).join(""),
      display_name: parts.join(""),
      address,
      lat: String(lat), lon: String(lng),
      source: "mlit",
      lg_code: admin.area ? admin.area.lg_code : undefined,
      machiaza_id: best.machiaza_id || undefined,
      postcode: best.post_code || undefined,
      nearby_place: nearby || undefined,
      distance_m: Math.round(bestDistance)
    };
  }
  return null;
}

async function nearestLocalPlace(latE6, lngE6, db) {
  const gridLat = Math.floor((latE6 / 1e6) * 100), gridLng = Math.floor((lngE6 / 1e6) * 100);
  try {
    for (const radius of [1, 3, 10]) {
      const result = await db.prepare(`
        SELECT id,kind,name,detail,lat_e6,lng_e6,source
        FROM nearby_places
        WHERE grid_lat BETWEEN ? AND ? AND grid_lng BETWEEN ? AND ?
        LIMIT 96
      `).bind(gridLat-radius, gridLat+radius, gridLng-radius, gridLng+radius).all();
      let best = null, distance = Infinity;
      for (const row of result.results || []) {
        const candidate = geoDistanceMeters(latE6/1e6, lngE6/1e6, row.lat_e6/1e6, row.lng_e6/1e6);
        if (candidate < distance) { best = row; distance = candidate; }
      }
      if (best && distance <= 20_000) return { id: best.id, kind: best.kind, name: best.name, detail: best.detail, source: best.source, distance_m: Math.round(distance) };
    }
  } catch (error) {
    // 段階導入中に場所テーブルがなくても住所検索は継続する。
  }
  return null;
}

async function findAdminArea(latE6, lngE6, databases) {
  let ready = 0;
  // Workersの同時外部接続上限は6本。9地域を2回に分け、見つけたDBだけを後続検索に使う。
  for (let offset = 0; offset < databases.length; offset += 6) {
    const results = await Promise.all(databases.slice(offset, offset + 6).map(async function (db) {
      try {
        const result = await db.prepare(`
          SELECT lg_code,prefecture,municipality,rings
          FROM admin_boundaries
          WHERE min_lat_e6<=? AND max_lat_e6>=? AND min_lng_e6<=? AND max_lng_e6>=?
          LIMIT 256
        `).bind(latE6, latE6, lngE6, lngE6).all();
        ready++;
        return { db, rows: result.results || [] };
      } catch (error) {
        return { db, rows: [] };
      }
    }));
    for (const result of results) for (const row of result.rows) {
      try {
        if (pointInPolygonRings(lngE6, latE6, decodeBoundaryRings(row.rings))) return { complete: false, area: row, db: result.db };
      } catch (error) {
        console.error("admin boundary decode error", error);
      }
    }
  }
  return { complete: ready === ADDRESS_DB_BINDINGS.length, area: null, db: null };
}

function decodeBoundaryRings(encoded) {
  if (!String(encoded || "").startsWith("v1:")) return JSON.parse(encoded);
  const binary = atob(encoded.slice(3)), bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let offset = 0;
  const read = () => { let value = 0, scale = 1, byte; do { byte = bytes[offset++]; value += (byte & 127) * scale; scale *= 128; } while (byte & 128); return value; };
  const unzigzag = (value) => value % 2 ? -(value + 1) / 2 : value / 2;
  const rings = [], count = read();
  for (let r = 0; r < count; r++) {
    const ring = []; let lng = 0, lat = 0, points = read();
    while (points--) { lng += unzigzag(read()); lat += unzigzag(read()); ring.push([lng, lat]); }
    rings.push(ring);
  }
  return rings;
}

function pointInPolygonRings(lngE6, latE6, rings) {
  let inside = false;
  for (const ring of rings) {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > latE6) !== (yj > latE6) && lngE6 < ((xj - xi) * (latE6 - yi)) / (yj - yi) + xi) hit = !hit;
    }
    if (hit) inside = !inside;
  }
  return inside;
}

function geoDistanceMeters(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const a1 = lat1 * rad, a2 = lat2 * rad;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dLng / 2) ** 2;
  return 12_742_000 * Math.asin(Math.min(1, Math.sqrt(h)));
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
  if (q.length > 120) return json({ error: "検索語が長すぎます" }, 400);

  if (!(await userLimit(env, me.id, "gsearch-hour", hourKey(), 60)) ||
      !(await userLimit(env, me.id, "gsearch-day", dayKey(), 300))) {
    return json({ error: "検索回数が多すぎます" }, 429);
  }
  if (!(await useQuota(env, "gsearch"))) {
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
  if (validCoords(lat, lng)) {
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
const LIMITS = { gsearch: 4500, vision: 900, gemini: 1200 };

function monthKey() {
  const d = new Date();
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

/** 1回ぶん使う。上限を超えていたら false */
async function useQuota(env, name) {
  const k = "q_" + name + "_" + monthKey();
  return atomicLimit(env, k, LIMITS[name] || 0, 1);
}

/* ============================================================
   写真を見て判断する

   ① 安全確認（Vision）… 不適切な画像を弾く。公開する以上、必須
   ② ひとことの提案（Gemini）… 「何を食べた？」の候補を出す

   どちらも回数の上限つき。安全確認は判定不能時も必ず非公開側へ倒す。
   ============================================================ */

const VISION = "https://vision.googleapis.com/v1/images:annotate";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

/** 写真が出しても大丈夫かを確かめる */
async function vision(request, env, me) {
  const key = await cfg(env, "google_key");
  if (!key) return json({ ok: false, error: "安全確認を利用できません" }, 503);

  const parsed = await limitedJson(request, 14_000_000);
  if (parsed.error) return parsed.error;
  const img = cleanBase64Image(parsed.value.image);
  if (!img) return json({ error: "画像が必要です" }, 400);

  const cached = await getModerationCache(env, me.id, img);
  if (cached) return json({ ok: cached.state === "ok", reason: cached.reason, labels: [] });

  if (!(await userLimit(env, me.id, "vision-hour", hourKey(), 30)) ||
      !(await userLimit(env, me.id, "vision-day", dayKey(), 120)) ||
      !(await useQuota(env, "vision"))) {
    return json({ ok: false, error: "安全確認の利用上限です" }, 429);
  }

  const result = await callVision(key, img);
  if (result.state === "error") {
    return json({ ok: false, error: "画像を安全確認できません" }, 503);
  }
  await putModerationCache(env, me.id, img, result);
  return json({
    ok: result.state === "ok",
    reason: result.state === "bad" ? "不適切な内容の可能性" : null,
    labels: result.labels
  });
}

function cleanBase64Image(value) {
  const img = String(value || "").replace(/^data:image\/[A-Za-z0-9.+-]+;base64,/, "");
  if (!img || img.length > 13_500_000 || !/^[A-Za-z0-9+/=\s]+$/.test(img)) return null;
  return img.replace(/\s/g, "");
}

async function callVision(key, img) {

  const res = await fetch(VISION + "?key=" + encodeURIComponent(key), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{
        image: { content: img },
        features: [
          { type: "SAFE_SEARCH_DETECTION" },
          { type: "LABEL_DETECTION", maxResults: 6 }
        ]
      }]
    })
  });

  if (!res.ok) return { state: "error", labels: [] };
  const j = await res.json();
  const r = (j.responses && j.responses[0]) || {};
  if (r.error || !r.safeSearchAnnotation) return { state: "error", labels: [] };
  const ss = r.safeSearchAnnotation || {};

  const bad = ["LIKELY", "VERY_LIKELY"];
  const ng = bad.includes(ss.adult) || bad.includes(ss.violence) ||
             bad.includes(ss.racy) || bad.includes(ss.medical);

  const labels = (r.labelAnnotations || []).map(function (x) { return x.description; });

  return { state: ng ? "bad" : "ok", labels: labels };
}

async function moderationKey(userId, img) {
  return "mod_" + dayKey() + "_" + userId + "_" + await shortHash(img);
}

async function getModerationCache(env, userId, img) {
  try {
    const r = await env.DB.prepare("SELECT v FROM app_config WHERE k=?")
      .bind(await moderationKey(userId, img)).first();
    if (!r || !["ok", "bad"].includes(r.v)) return null;
    return { state: r.v, reason: r.v === "bad" ? "不適切な内容の可能性" : null };
  } catch (e) { return null; }
}

async function putModerationCache(env, userId, img, result) {
  if (!["ok", "bad"].includes(result.state)) return;
  try {
    await env.DB.prepare(
      "INSERT INTO app_config (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v"
    ).bind(await moderationKey(userId, img), result.state).run();
  } catch (e) {}
}

function bytesToBase64(buffer) {
  const u = new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** 公開・フレンド向け画像は、クライアント申告を信じずWorker自身でも判定する。 */
async function moderateUploadedPhoto(env, me, bytes) {
  const img = bytesToBase64(bytes);
  const cached = await getModerationCache(env, me.id, img);
  if (cached) return cached.state;
  const key = await cfg(env, "google_key");
  if (!key ||
      !(await userLimit(env, me.id, "vision-hour", hourKey(), 30)) ||
      !(await userLimit(env, me.id, "vision-day", dayKey(), 120)) ||
      !(await useQuota(env, "vision"))) return "error";
  const result = await callVision(key, img);
  await putModerationCache(env, me.id, img, result);
  return result.state;
}

async function ensurePostPhotosModerated(env, me, postId) {
  const rows = await env.DB.prepare(
    "SELECT key_orig,key_view,key_thumb FROM photos WHERE post_id=? AND user_id=?"
  ).bind(postId, me.id).all();
  return moderatePhotoRows(env, me, rows.results || []);
}

async function moderatePhotoRows(env, me, rows) {
  for (const ph of rows) {
    for (const col of ["key_orig", "key_view", "key_thumb"]) {
      if (!ph[col]) continue;
      const obj = await env.PHOTOS.get(ph[col]);
      if (!obj) return false;
      const bytes = await obj.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 10_000_000) return false;
      if ((await moderateUploadedPhoto(env, me, bytes)) !== "ok") return false;
    }
  }
  return true;
}

/** 写真を見て、ひとことの候補を出す */
async function suggest(request, env, me) {
  const key = await cfg(env, "google_key");
  if (!key) return json({ items: [] });

  const parsed = await limitedJson(request, 14_000_000);
  if (parsed.error) return parsed.error;
  const b = parsed.value;
  const img = cleanBase64Image(b.image);
  if (!img) return json({ items: [] });

  if (!(await userLimit(env, me.id, "suggest-hour", hourKey(), 30)) ||
      !(await userLimit(env, me.id, "suggest-day", dayKey(), 120))) {
    return json({ error: "提案の利用回数が多すぎます" }, 429);
  }
  if (!(await useQuota(env, "gemini"))) return json({ items: [] });

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
  const parsed = await limitedJson(request, 8_000);
  if (parsed.error) return parsed.error;
  const b = parsed.value;
  const t = String(b.token || "").trim();
  if (!t || t.length > 4096 || /\s/.test(t)) return json({ error: "宛先が不正です" }, 400);
  if (!(await userLimit(env, me.id, "push-token-hour", hourKey(), 20))) {
    return json({ error: "登録回数が多すぎます" }, 429);
  }
  const platform = ["ios", "android", "web"].includes(b.platform) ? b.platform : "ios";
  await env.DB.prepare(`
    INSERT INTO push_tokens (token, user_id, platform, updated_at)
    VALUES (?,?,?,?)
    ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id, updated_at=excluded.updated_at
  `).bind(t, me.id, platform, Date.now()).run();
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
  if (!(await userLimit(env, me.id, "push-test-hour", hourKey(), 10))) {
    return json({ error: "テスト回数が多すぎます" }, 429);
  }
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
  const parsed = await limitedJson(request, 12_000);
  if (parsed.error) return parsed.error;
  const b = parsed.value;
  const postId = String(b.post_id || "");
  const ids = Array.isArray(b.user_ids)
    ? Array.from(new Set(b.user_ids.map(String).filter(function (id) {
        return /^[A-Za-z0-9_-]{8,80}$/.test(id);
      }))).slice(0, 20)
    : [];
  if (!postId || !ids.length) return json({ error: "指定が足りません" }, 400);
  if (!(await userLimit(env, me.id, "tags-hour", hourKey(), 30))) {
    return json({ error: "タグ付け回数が多すぎます" }, 429);
  }

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
      { post: postId, tag: "1" });
    n++;
  }
  return json({ ok: true, count: n });
}

/** 自分に付いた、まだ返事をしていないもの */
async function myTags(env, me) {
  const rows = await env.DB.prepare(`
    SELECT t.post_id, t.created_at,
           p.title, p.category, p.tag, p.place_name, p.taken_at,
           p.lat, p.lng, p.approx_lat, p.approx_lng, p.area_lat, p.area_lng,
           p.fixed_lat, p.fixed_lng,
           CASE WHEN EXISTS (
             SELECT 1 FROM friendships f
              WHERE f.status='accepted'
                AND ((f.requester_id=t.user_id AND f.addressee_id=p.user_id)
                  OR (f.requester_id=p.user_id AND f.addressee_id=t.user_id))
           ) THEN u.friend_precision ELSE u.public_precision END AS precision,
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
    let coords = null;
    if (r.fixed_lat != null && r.fixed_lng != null) {
      coords = [r.fixed_lat, r.fixed_lng, "fixed"];
    } else if (r.precision === "exact") {
      coords = [r.lat, r.lng, "exact"];
    } else if (r.precision === "approx") {
      coords = [r.approx_lat, r.approx_lng, "approx"];
    } else if (r.precision === "area") {
      coords = [r.area_lat, r.area_lng, "area"];
    }
    out.push({
      post_id: r.post_id, title: r.title, category: r.category,
      tag: r.tag, place_name: r.place_name,
      lat: coords ? coords[0] : null, lng: coords ? coords[1] : null,
      precision: coords ? coords[2] : "hidden", taken_at: r.taken_at,
      photo_id: ph ? ph.id : null,
      from: { id: r.from_id, name: r.display_name || r.handle || "" }
    });
  }
  return json({ count: out.length, tags: out });
}

/** 「自分の思い出にする」を押したとき。写真ごと自分のものとして作る */
async function takeTag(request, env, me) {
  const parsed = await limitedJson(request, 4_000);
  if (parsed.error) return parsed.error;
  const b = parsed.value;
  const postId = String(b.post_id || "");
  const take = b.take !== false;
  if (!(await userLimit(env, me.id, "tag-decisions-hour", hourKey(), 30))) {
    return json({ error: "操作回数が多すぎます" }, 429);
  }

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

  const src = await env.DB.prepare(`
    SELECT p.*,u.friend_precision,u.public_precision
      FROM posts p JOIN users u ON u.id=p.user_id
     WHERE p.id=? AND p.deleted_at IS NULL
  `)
    .bind(postId).first();
  if (!src) return json({ error: "元の思い出がありません" }, 404);

  // 受信者へ渡す座標も、投稿者が設定した現在の精度を必ず通す。
  let shared = null;
  if (src.fixed_lat != null && src.fixed_lng != null && validCoords(src.fixed_lat, src.fixed_lng)) {
    shared = [src.fixed_lat, src.fixed_lng];
  } else {
    const precision = (await areFriends(env, me.id, src.user_id))
      ? src.friend_precision : src.public_precision;
    if (precision === "exact") shared = [src.lat, src.lng];
    else if (precision === "approx") shared = [src.approx_lat, src.approx_lng];
    else if (precision === "area") shared = [src.area_lat, src.area_lng];
  }
  if (!shared || !validCoords(Number(shared[0]), Number(shared[1]))) {
    return json({ error: "投稿者が位置を非公開にしています" }, 403);
  }
  const sharedLat = Number(shared[0]), sharedLng = Number(shared[1]);
  const [sharedApproxLat, sharedApproxLng] = snap(sharedLat, sharedLng, 500);
  const [sharedAreaLat, sharedAreaLng] = snap(sharedLat, sharedLng, 2000);

  const now = Date.now();
  const newId = uuid();
  const phs = await env.DB.prepare("SELECT * FROM photos WHERE post_id=?")
    .bind(postId).all();
  let newVisibility = ["private", "friends", "public"].includes(me.default_visibility)
    ? me.default_visibility : "private";
  if (newVisibility !== "private" &&
      !(await moderatePhotoRows(env, me, phs.results || []))) newVisibility = "private";

  await env.DB.prepare(`
    INSERT INTO posts (
      id,user_id,place_id,title,category,tag,place_name,body,
      lat,lng,approx_lat,approx_lng,area_lat,area_lng,
      taken_at,created_at,visibility,publish_at
    ) VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)
  `).bind(
    newId, me.id, src.place_id, src.title, src.category, src.tag,
    src.place_name, src.body,
    sharedLat, sharedLng, sharedApproxLat, sharedApproxLng, sharedAreaLat, sharedAreaLng,
    src.taken_at, now, newVisibility,
    now + (me.publish_delay_sec || 0) * 1000
  ).run();

  // 写真は同じものを指す。ここで複製すると容量が倍になる
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
   Wikipedia 周辺記事（最新版UIとの互換機能）
   ============================================================ */
const WIKI_UA = "spota/1.0 (https://broad-wildflower-9e30.j4hrd7zdgc.workers.dev)";

function wikiCat(value) {
  const text = String(value || "");
  if (/温泉|銭湯|浴場/.test(text)) return "湯";
  if (/神社|寺院|寺|大社|神宮|仏閣/.test(text)) return "社";
  if (/公園|庭園|植物園|渓谷|滝|湖沼/.test(text)) return "園";
  if (/図書館|書店/.test(text)) return "本";
  return "景";
}

async function wiki(url, request, env) {
  const mode = url.searchParams.get("mode") || "near";
  if (!(await publicAllowance(request, env, "wiki", 60, 500))) {
    return json({ error: "検索回数が多すぎます" }, 429);
  }
  if (mode === "near") return wikiNear(url, env);
  if (mode === "views") return wikiViews(url, env);
  return json({ error: "mode が不正です" }, 400);
}

async function wikiNear(url, env) {
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!validCoords(lat, lng)) return json({ error: "lat / lng が必要です" }, 400);
  const radius = Math.min(10_000, Math.max(500, Number(url.searchParams.get("radius") || 3000)));
  const local = await wikiNearFromD1(lat, lng, radius, env);
  if (local) return json(local);
  const cacheKey = "wiki_" + lat.toFixed(2) + "," + lng.toFixed(2) + "," + Math.round(radius / 1000);
  const cached = await dataCacheGet(env, cacheKey, 86400);
  if (cached) return json(Object.assign({ cached: true }, cached));

  const api = new URL("https://ja.wikipedia.org/w/api.php");
  for (const [key, value] of Object.entries({
    action: "query", format: "json", formatversion: "2", generator: "geosearch",
    ggscoord: lat.toFixed(6) + "|" + lng.toFixed(6), ggsradius: String(radius),
    ggslimit: "60", prop: "coordinates|description|pageimages|categories",
    cllimit: "30", clshow: "!hidden", piprop: "thumbnail", pithumbsize: "320"
  })) api.searchParams.set(key, value);
  const response = await fetch(api, {
    headers: { "User-Agent": WIKI_UA, "Accept": "application/json" },
    cf: { cacheTtl: 86400, cacheEverything: true }
  });
  if (!response.ok) return json({ error: "Wikipediaを利用できません", pages: [] }, 200);
  const body = await response.json();
  const pages = ((body.query && body.query.pages) || []).map(function (page) {
    const coordinate = page.coordinates && page.coordinates[0];
    if (!coordinate || !validCoords(coordinate.lat, coordinate.lon)) return null;
    return {
      title: limitedText(page.title, 200) || "", lat: coordinate.lat, lng: coordinate.lon,
      desc: limitedText(page.description, 500) || "",
      photo: page.thumbnail ? page.thumbnail.source : "",
      cats: (page.categories || []).slice(0, 30).map((item) => String(item.title || "").replace(/^Category:/, ""))
    };
  }).filter(Boolean);
  const out = { count: pages.length, pages };
  await dataCacheSet(env, cacheKey, out);
  await savePlaces(env, pages.map(function (page) {
    return {
      n: page.title, lat: page.lat, lng: page.lng,
      c: wikiCat(page.title + " " + page.desc + " " + page.cats.join(" ")),
      src: "user", sid: "wk_" + page.title, gname: page.desc || null
    };
  }));
  return json(out);
}

async function wikiNearFromD1(lat, lng, radius, env) {
  const databases = ADDRESS_DB_BINDINGS.map((name) => env[name]).filter(Boolean);
  if (!databases.length) return null;
  const latDelta = radius / 110_540;
  const lngDelta = radius / Math.max(1, 111_320 * Math.cos(lat * Math.PI / 180));
  const minGridLat = Math.floor((lat - latDelta) * 100), maxGridLat = Math.floor((lat + latDelta) * 100);
  const minGridLng = Math.floor((lng - lngDelta) * 100), maxGridLng = Math.floor((lng + lngDelta) * 100);
  const latE6 = Math.round(lat * 1e6), lngE6 = Math.round(lng * 1e6);
  const found = [];
  // Workersの同時外部接続上限6本を超えないよう、地域DBを2回に分ける。
  for (let offset = 0; offset < databases.length; offset += 6) {
    const batches = await Promise.all(databases.slice(offset, offset + 6).map(async function (db) {
      try {
        const result = await db.prepare(`
          SELECT page_id,title,type,lat_e6,lng_e6
          FROM wikipedia_places
          WHERE grid_lat BETWEEN ? AND ? AND grid_lng BETWEEN ? AND ?
          ORDER BY ((lat_e6-?)*(lat_e6-?))+((lng_e6-?)*(lng_e6-?))
          LIMIT 160
        `).bind(minGridLat, maxGridLat, minGridLng, maxGridLng,
                latE6, latE6, lngE6, lngE6).all();
        return result.results || [];
      } catch (error) { return []; }
    }));
    found.push(...batches.flat());
  }
  if (!found.length) return null;
  const pages = found.map(function (row) {
    const pageLat = row.lat_e6 / 1e6, pageLng = row.lng_e6 / 1e6;
    return {
      title: row.title, lat: pageLat, lng: pageLng, desc: "", photo: "", cats: [],
      type: row.type || "", distance_m: Math.round(geoDistanceMeters(lat, lng, pageLat, pageLng)),
      page_id: row.page_id
    };
  }).filter((page) => page.distance_m <= radius)
    .sort((a, b) => a.distance_m - b.distance_m).slice(0, 60);
  return pages.length ? { count: pages.length, pages, source: "jawiki-dump" } : null;
}

async function wikiViews(url, env) {
  const titles = String(url.searchParams.get("titles") || "").split("|")
    .map((title) => title.trim()).filter(Boolean).slice(0, 15);
  if (!titles.length) return json({ views: {} });
  const end = new Date(Date.now() - 86400000);
  const start = new Date(end.getTime() - 6 * 86400000);
  const formatDate = (date) => date.toISOString().slice(0, 10).replace(/-/g, "") + "00";
  const span = formatDate(start) + "/" + formatDate(end), views = {};
  for (const title of titles) {
    const key = "pv_" + span + "_" + title;
    const cached = await dataCacheGet(env, key, 86400);
    if (cached) { views[title] = cached.v; continue; }
    try {
      const endpoint = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/ja.wikipedia/all-access/user/" +
        encodeURIComponent(title.replace(/ /g, "_")) + "/daily/" + span;
      const response = await fetch(endpoint, { headers: { "User-Agent": WIKI_UA }, cf: { cacheTtl: 86400, cacheEverything: true } });
      if (!response.ok) { views[title] = 0; continue; }
      const body = await response.json();
      views[title] = (body.items || []).reduce((sum, item) => sum + (item.views || 0), 0);
      await dataCacheSet(env, key, { v: views[title] });
    } catch (error) { views[title] = 0; }
  }
  return json({ views });
}

async function dataCacheGet(env, key, maxAgeSeconds) {
  try {
    const row = await env.DB.prepare("SELECT v,at FROM api_cache WHERE k=?").bind(key).first();
    if (!row || Date.now() - row.at > maxAgeSeconds * 1000) return null;
    return JSON.parse(row.v);
  } catch (error) { return null; }
}

async function dataCacheSet(env, key, value) {
  try {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO api_cache (k,v,at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=?,at=?")
      .bind(key, JSON.stringify(value), now, JSON.stringify(value), now).run();
  } catch (error) {}
}
