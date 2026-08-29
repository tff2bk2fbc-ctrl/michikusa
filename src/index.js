/**
 * 思い出保存アプリ / サーバー（Cloudflare Worker）
 *
 *  /api/*      … このコードが処理
 *  それ以外     … public/ の静的ファイル
 *
 *  必要なもの
 *   - D1  : binding "DB"
 *   - R2  : binding "PHOTOS"
 *   - Secrets: GOOGLE_API_KEY / FCM_RELAY_SHARED_SECRET（通知中継を有効にする場合）
 *   - Var    : FIREBASE_PROJECT_ID
 *
 *  原則
 *   1. 真の座標は本人以外に絶対に返さない
 *   0. 反映は即時。遅延は設定で選ぶ（0 / 1h / 3h / 翌朝）
 *   2. 公開範囲の判定はすべてここで行う。画面側で隠すのは無意味
 *   3. 位置はランダムにずらさず、マス目へ吸着させる
 *      （ずらすだけだと、繰り返し観測して平均を取れば真の位置が割れる）
 */

import { fetchWikipediaPlaceSearch, WikipediaApiError } from "./lib/wikipedia.js";

const JWKS = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const POSTAL_CODE_API = "https://jp-postal-code-api.ttskch.com/api/v1/";
const CURRENT_TERMS_VERSION = "2026-08-17.1";
const CURRENT_PRIVACY_VERSION = "2026-08-17.1";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const respond = (response) => cors(response, request);

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
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: capacitor:",
          "connect-src 'self' capacitor: https://broad-wildflower-9e30.j4hrd7zdgc.workers.dev https://tiles.openfreemap.org https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.firebaseapp.com",
          "font-src 'self' data:",
          "worker-src 'self' blob:",
          "frame-src https://*.firebaseapp.com https://accounts.google.com https://appleid.apple.com",
          "object-src 'none'",
          "base-uri 'self'",
          "frame-ancestors 'none'"
        ].join("; "));
      }
      return secure(new Response(res.body, { status: res.status, headers: h }));
    }

    if (request.method === "OPTIONS") return respond(new Response(null, { status: 204 }));

    try {
      if (p === "/api/health") {
        return respond(json({
          ok: true,
          build: "api-45"
        }));
      }
      if (p === "/api/places" && request.method === "POST")
        return respond(await nearbyPlaces(request, env));
      if (p === "/api/places") return respond(json({ error: "POSTだけです" }, 405));
      if (p === "/api/geocode")   return respond(await geocode(request, env));
      if (p === "/api/reverse")   return respond(await reverseGeocode(request, env));
      const sharedPhotoRoute = /^\/api\/share\/([A-Za-z0-9_-]{20,120})\/photo\/([A-Za-z0-9_-]{8,80})\/(thumb|view)$/.exec(p);
      if (sharedPhotoRoute && request.method === "GET")
        return respond(await getSharedPhoto(sharedPhotoRoute[1], sharedPhotoRoute[2], sharedPhotoRoute[3], request, env));
      if (p.startsWith("/api/share/") && request.method === "GET")
        return respond(await resolveShareLink(p.slice("/api/share/".length), request, env));
      // 運営者が手動確認して公開した、地図検索用の短い急上昇ワードだけを返す。
      // 外部のトレンド画面・利用者情報・監査情報は一切ここから返さない。
      if (p === "/api/public/map-trends" && request.method === "GET")
        return respond(await publicMapTrends(env));
      if (p === "/api/public/map-trends") return respond(json({ error: "GETだけです" }, 405));

      // 認証処理より前にmethodを固定し、非POST bodyで申請処理へ到達させない。
      if (p === "/api/friends" && request.method !== "GET")
        return respond(json({ error: "GETだけです" }, 405));
      if ((p === "/api/friends/request" || p === "/api/friends/accept") && request.method !== "POST")
        return respond(json({ error: "POSTだけです" }, 405));

      // ---- ここから先はログインが必要 ----
      const me = await authenticate(request, env);
      if (!me) return respond(json({ error: "ログインが必要です" }, 401));

      // 運営者用の入口は、表示を隠すだけでなく必ずサーバーでUID許可リストを照合する。
      // 認可済みユーザーだけが、公開中の急上昇ワードの読み書きに到達できる。
      if (p === "/api/admin/map-trends") {
        if (!(await isMapTrendEditor(env, me)))
          return respond(json({ error: "運営者権限が必要です" }, 403));
        if (request.method === "GET") return respond(await getMapTrendEditorTerms(env));
        if (request.method === "PUT") return respond(await replaceMapTrendTerms(request, env, me));
        return respond(json({ error: "GETまたはPUTだけです" }, 405));
      }

      if (p === "/api/wiki/search" && request.method === "POST")
        return respond(await wikipediaSearch(request, env, me));
      if (p === "/api/wiki/search") return respond(json({ error: "POSTだけです" }, 405));

      // ユーザーに紐づく通知・タグ操作は必ず認証後に置く。
      if (p === "/api/postal-code" && request.method === "POST")
        return respond(await postalCodeLookup(request, env, me));
      if (p === "/api/postal-code") return respond(json({ error: "POSTだけです" }, 405));
      if (p === "/api/push/token" && request.method === "POST") return respond(await saveToken(request, env, me));
      if (p === "/api/push/token" && request.method === "DELETE") return respond(await deleteToken(request, env, me));
      if (p === "/api/push/test"  && request.method === "POST") return respond(await pushTest(env, me));
      if (p === "/api/tags" && request.method === "POST")  return respond(await addTags(request, env, me));
      if (p === "/api/tags" && request.method === "GET")   return respond(await myTags(env, me));
      if (p === "/api/tags/accept" && request.method === "POST") return respond(await takeTag(request, env, me));

      if (p === "/api/me" && request.method === "GET")    return respond(json(await getMe(env, me)));
      if (p === "/api/me" && request.method === "PATCH")  return respond(await patchMe(request, env, me));
      if (p === "/api/legal/acceptance" && request.method === "POST")
        return respond(await saveLegalAcceptance(request, env, me));
      if (p === "/api/legal/acceptance") return respond(json({ error: "POSTだけです" }, 405));
      if (p === "/api/account/delete" && request.method === "POST")
        return respond(await deleteAccount(request, env, me));
      if (p === "/api/account/delete") return respond(json({ error: "POSTだけです" }, 405));

      if (p === "/api/reports" && request.method === "POST")
        return respond(await createReport(request, env, me));
      if (p === "/api/reports") return respond(json({ error: "POSTだけです" }, 405));

      if (p === "/api/monitor/run" && request.method === "POST")
        return respond(await runCommunicationMonitor(env, me));
      if (p === "/api/monitor/receipt" && request.method === "POST")
        return respond(await saveMonitorReceipt(request, env, me));
      const monitorRoute = /^\/api\/monitor\/([A-Za-z0-9_-]{8,80})$/.exec(p);
      if (monitorRoute && request.method === "GET")
        return respond(await getCommunicationMonitor(monitorRoute[1], env, me));

      if (p === "/api/posts" && request.method === "GET") {
        const handle = String(url.searchParams.get("user") || "").trim();
        if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(handle))
          return respond(json({ error: "ユーザーIDが不正です" }, 400));
        return respond(await listProfilePosts(handle, url, env, me));
      }
      if (p === "/api/posts" && request.method === "POST") return respond(await createPost(request, env, me));
      if (p === "/api/posts/query" && request.method === "POST")
        return respond(await listPostsQuery(request, env, me));
      if (p === "/api/feed" && request.method === "POST")
        return respond(await listFeedQuery(request, env, me));
      if (p === "/api/feed") return respond(json({ error: "POSTだけです" }, 405));
      if (p === "/api/hashtags/trending" && request.method === "GET")
        return respond(await trendingHashtags(url, env, me));
      const likeRoute = /^\/api\/posts\/([A-Za-z0-9_-]{8,80})\/like$/.exec(p);
      if (likeRoute && request.method === "PUT")
        return respond(await putLike(likeRoute[1], env, me));
      if (likeRoute && request.method === "DELETE")
        return respond(await deleteLike(likeRoute[1], env, me));
      const flashRoute = /^\/api\/posts\/([A-Za-z0-9_-]{8,80})\/flash$/.exec(p);
      if (flashRoute && request.method === "POST")
        return respond(await flashPost(flashRoute[1], env, me));
      const commentsRoute = /^\/api\/posts\/([A-Za-z0-9_-]{8,80})\/comments(?:\/([A-Za-z0-9_-]{8,80}))?$/.exec(p);
      if (commentsRoute && !commentsRoute[2] && request.method === "GET")
        return respond(await listComments(commentsRoute[1], url, env, me));
      if (commentsRoute && !commentsRoute[2] && request.method === "POST")
        return respond(await createComment(commentsRoute[1], request, env, me));
      if (commentsRoute && commentsRoute[2] && request.method === "DELETE")
        return respond(await deleteComment(commentsRoute[1], commentsRoute[2], env, me));
      if (p === "/api/posts/ownership" && request.method === "POST")
        return respond(await ownedPostIds(request, env, me));
      if (p === "/api/posts/deletions" && request.method === "GET")
        return respond(await deletedPostIds(url, env, me));
      if (p === "/api/posts/mine" && request.method === "GET")
        return respond(await ownPostArchive(url, env, me));
      if (p.startsWith("/api/posts/") && request.method === "DELETE")
        return respond(await deletePost(p.split("/")[3], env, me));
      if (p.startsWith("/api/posts/") && request.method === "PATCH")
        return respond(await patchPost(p.split("/")[3], request, env, me));

      if (p === "/api/photo" && request.method === "PUT")  return respond(await putPhoto(url, request, env, me));
      if (p.startsWith("/api/photo/") && request.method === "GET")
        return respond(await getPhoto(p, env, me));

      if (p === "/api/friends" && request.method === "GET") {
        if (!(await socialReadLimit(env, me, "friends")))
          return respond(json({ error: "読み込み回数が多すぎます" }, 429));
        return respond(json(await listFriends(env, me)));
      }
      if (p === "/api/friends") return respond(json({ error: "GETだけです" }, 405));
      if (p === "/api/friends/request" && request.method === "POST")
        return respond(await friendRequest(request, env, me));
      if (p === "/api/friends/request") return respond(json({ error: "POSTだけです" }, 405));
      if (p === "/api/friends/accept" && request.method === "POST")
        return respond(await friendAccept(request, env, me));
      if (p === "/api/friends/accept") return respond(json({ error: "POSTだけです" }, 405));
      if (p === "/api/block" && request.method === "POST")
        return respond(await blockUser(request, env, me));

      if (p === "/api/follows" && request.method === "GET")
        return respond(await listFollows(url, env, me));
      const followRoute = /^\/api\/follows\/([A-Za-z0-9_.-]{3,30})$/.exec(p);
      if (followRoute && request.method === "PUT")
        return respond(await putFollow(decodeURIComponent(followRoute[1]), env, me));
      if (followRoute && request.method === "DELETE")
        return respond(await deleteFollow(decodeURIComponent(followRoute[1]), env, me));

      if (p === "/api/notifications" && request.method === "GET")
        return respond(await listNotifications(url, env, me));
      if (p === "/api/notifications/read" && request.method === "PATCH")
        return respond(await readNotifications(request, env, me));
      if (p === "/api/unread" && request.method === "GET")
        return respond(await unreadSummary(env, me));

      if (p === "/api/conversations" && request.method === "GET")
        return respond(await listConversations(env, me));
      if (p === "/api/conversations" && request.method === "POST")
        return respond(await createConversation(request, env, me));
      const messagesRoute = /^\/api\/conversations\/([A-Za-z0-9_-]{8,80})\/messages$/.exec(p);
      if (messagesRoute && request.method === "GET")
        return respond(await listMessages(messagesRoute[1], url, env, me));
      if (messagesRoute && request.method === "POST")
        return respond(await createMessage(messagesRoute[1], request, env, me));
      const readConversationRoute = /^\/api\/conversations\/([A-Za-z0-9_-]{8,80})\/read$/.exec(p);
      if (readConversationRoute && request.method === "PATCH")
        return respond(await readConversation(readConversationRoute[1], request, env, me));

      if (p === "/api/albums" && request.method === "GET")
        return respond(await listAlbums(url, env, me));
      if (p === "/api/albums" && request.method === "POST")
        return respond(await createAlbum(request, env, me));
      const albumRoute = /^\/api\/albums\/([A-Za-z0-9_-]{8,80})$/.exec(p);
      if (albumRoute && request.method === "GET")
        return respond(await getAlbum(albumRoute[1], env, me));
      if (albumRoute && request.method === "PATCH")
        return respond(await patchAlbum(albumRoute[1], request, env, me));
      if (albumRoute && request.method === "DELETE")
        return respond(await deleteAlbum(albumRoute[1], env, me));
      const albumItemsRoute = /^\/api\/albums\/([A-Za-z0-9_-]{8,80})\/items$/.exec(p);
      if (albumItemsRoute && request.method === "POST")
        return respond(await replaceAlbumItems(albumItemsRoute[1], request, env, me));

      if (p === "/api/shares" && request.method === "POST")
        return respond(await createShareLink(request, env, me));
      const shareRoute = /^\/api\/shares\/([A-Za-z0-9_-]{20,120})$/.exec(p);
      if (shareRoute && request.method === "DELETE")
        return respond(await revokeShareLink(shareRoute[1], env, me));

      return respond(json({ error: "そのAPIはありません" }, 404));
    } catch (e) {
      // DB名や外部APIの詳細を利用者へ返さない。
      console.error("api error", safeLogError(e));
      return respond(json({ error: "サーバー内エラー" }, 500));
    }
  },

  async scheduled(event, env, ctx) {
    // 公開遅延が満了した投稿は15分ごとに通知へ反映する。
    // 容量整理は従来どおり03:17 JST（18:17 UTC）だけ実行する。
    const work = [retryErroredPhotoModeration(env), announceReadyPosts(env)];
    if (event.cron === "17 18 * * *") {
      work.push(cleanupTransientConfig(env), cleanupDeletedPhotos(env), cleanupCommunicationMonitors(env));
    }
    work.push(resumeAccountDeletions(env));
    ctx.waitUntil(Promise.all(work));
  }
};


/* ============================================================
   本人確認（Firebase の ID トークンを検証する）
   ============================================================ */

let jwksCache = null, jwksAt = 0;

async function getJwks() {
  const now = Date.now();
  if (jwksCache && now - jwksAt < 3600_000) return jwksCache;
  const r = await fetch(JWKS, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error("authentication keys unavailable");
  const text = await r.text();
  if (new TextEncoder().encode(text).byteLength > 200_000)
    throw new Error("authentication keys invalid");
  jwksCache = JSON.parse(text);
  jwksAt = now;
  return jwksCache;
}

/* ============================================================
   Wikipedia公開メタデータ検索

   ブラウザからWikipediaへ直接接続させず、認証済みのWorkerで
   検索語・件数・応答サイズ・利用回数を制限する。本文・画像・利用者情報は取得しない。
   ============================================================ */
async function wikipediaSearch(request, env, me) {
  // 接続レジストリの承認をサーバー設定でも強制する。未設定・disabledの
  // 本番Workerからは、認証済みでも外部APIへ一切接続しない。
  if (!wikipediaApiEnabled(env)) return json({ error: "Wikipedia検索は準備中です" }, 503);
  const parsed = await limitedJson(request, 512);
  if (parsed.error) return parsed.error;
  const q = String(parsed.value.q || "").trim();
  if (!q || q.length > 80 || /[\u0000-\u001f\u007f]/.test(q)) {
    return json({ error: "検索語が不正です" }, 400);
  }
  const limit = Math.min(5, Math.max(1, Number.parseInt(String(parsed.value.limit || "5"), 10) || 5));
  const rateKey = await shortHash(me.id);
  if (!(await burstLimit(env, "SOCIAL_READ_RATE_LIMITER", `wiki:${rateKey}`)) ||
      !(await userLimit(env, me.id, "wiki-search-hour", hourKey(), 60)) ||
      !(await atomicLimit(env, "wiki_search_day_" + dayKey(), 5_000, 1))) {
    return json({ error: "Wikipedia検索が混み合っています" }, 429);
  }

  const key = "wikipedia/search/" + await shortHash(q.toLocaleLowerCase("ja")) + "/" + limit;
  return cachedNominatim(key, 600, async function () {
    try {
      const payload = await fetchWikipediaPlaceSearch(q, { limit });
      const response = json(payload);
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "public, max-age=600, stale-while-revalidate=3600");
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      if (error instanceof WikipediaApiError && error.code === "invalid_query") {
        return json({ error: "検索語が不正です" }, 400);
      }
      if (error instanceof WikipediaApiError && error.code === "rate_limited") {
        const response = json({ error: "Wikipedia検索が混み合っています" }, 503);
        if (error.retryAfter) response.headers.set("Retry-After", error.retryAfter);
        return response;
      }
      return json({ error: "Wikipedia検索を利用できません" }, 502);
    }
  });
}

function wikipediaApiEnabled(env) {
  const state = String(env?.WIKIPEDIA_API_STATE || "").trim().toLowerCase();
  return state === "staging" || state === "live";
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
    const user = await env.DB.prepare("SELECT * FROM users WHERE id=? AND deleted_at IS NULL")
      .bind(found.user_id).first();
    return attachFirebaseUid(user, uid);
  }

  // Firebase削除直後も、発行済みID tokenは最大1時間ほど端末に残り得る。
  // その古いtokenで削除済みアカウントを即時再作成させない。2時間後は、
  // 新しい本人確認で改めて登録できるようにする。
  const recentDeletion = await env.DB.prepare(`SELECT 1 FROM account_deletion_jobs
    WHERE provider=? AND provider_uid_hash=? AND status='completed'
      AND completed_at>? LIMIT 1`)
    .bind(provider, await shortHash(uid), Date.now() - 2 * 60 * 60 * 1000).first();
  if (recentDeletion) return null;

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
  return attachFirebaseUid(await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(userId).first(), uid);
}

/**
 * Firebase UIDは権限照合のためだけに、サーバー内のユーザー行へ付与する。
 * enumerable にしないことで、既存のレスポンスで誤ってシリアライズされない。
 */
function attachFirebaseUid(user, firebaseUid) {
  if (!user || !firebaseUid) return user || null;
  Object.defineProperty(user, "_firebase_uid", {
    value: String(firebaseUid), enumerable: false, configurable: false, writable: false
  });
  return user;
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

/** 旧クライアントが逆引き失敗時に保存した正確な座標文字列を外へ出さない。 */
function publicLocationLabel(value) {
  const text = String(value || "");
  return /^\s*-?\d{1,2}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}\s*$/.test(text)
    ? "撮影場所" : text;
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
    profile_icon: me.profile_icon || "pin",
    settings: {
      default_visibility: me.default_visibility,
      friend_precision:   me.friend_precision,
      public_precision:   me.public_precision,
      publish_delay_sec:  me.publish_delay_sec,
      profile_public:     !!me.profile_public
    }
  };
}

/* ============================================================
   運営者が手動公開する「急上昇ワード」

   Google Trendsなどの画面を自動取得しない。運営者が確認した最大3件を
   D1に保存し、公開読み取りと編集読み書きを別経路にする。
   ============================================================ */

const MAP_TREND_LIMIT = 3;

function mapTrendText(value, max) {
  const text = String(value == null ? "" : value).trim().replace(/\s+/g, " ");
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function validTrendDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeMapTrendTerms(value) {
  if (!Array.isArray(value)) return { error: "急上昇ワードの形式が不正です" };
  if (value.length > MAP_TREND_LIMIT) return { error: "急上昇ワードは3件までです" };

  const terms = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { error: "急上昇ワードの形式が不正です" };
    const label = mapTrendText(raw.label, 48);
    const query = mapTrendText(raw.query, 80);
    const sourceLabel = mapTrendText(raw.source_label || "Google Trends 手動確認", 48);
    const observedOn = mapTrendText(raw.observed_on || "", 10);
    const completelyBlank = !String(raw.label || "").trim() && !String(raw.query || "").trim() &&
      !String(raw.observed_on || "").trim();
    if (completelyBlank) continue;
    if (!label || !query || !sourceLabel || !observedOn || !validTrendDate(observedOn))
      return { error: "表示名・検索語・確認日を正しく入力してください" };
    const key = label.normalize("NFKC").toLocaleLowerCase("ja-JP");
    if (seen.has(key)) return { error: "同じ表示名は1回だけ登録できます" };
    seen.add(key);
    terms.push({ label, query, source_label: sourceLabel, observed_on: observedOn });
  }
  return { value: terms };
}

/** Firebase ID tokenから得たUIDを、D1の明示許可リストで二次照合する。 */
async function isMapTrendEditor(env, me) {
  const firebaseUid = me && me._firebase_uid;
  if (!firebaseUid) return false;
  try {
    const row = await env.DB.prepare(`
      SELECT role FROM trend_admins
       WHERE firebase_uid=? AND enabled=1 AND revoked_at IS NULL
       LIMIT 1
    `).bind(firebaseUid).first();
    return !!(row && row.role === "trend_editor");
  } catch (_) {
    // migration未適用時を含め、権限を推測して許可しない。
    return false;
  }
}

async function publicMapTrends(env) {
  try {
    const rows = await env.DB.prepare(`
      SELECT slot,label,query FROM map_trend_terms
       ORDER BY slot ASC LIMIT ?
    `).bind(MAP_TREND_LIMIT).all();
    const terms = (rows.results || []).map(function (row) {
      return { slot: Number(row.slot), label: String(row.label), query: String(row.query) };
    });
    return publicJson({ terms });
  } catch (_) {
    // 公開帯を隠すだけで、地図本体や位置情報の表示を止めない。
    return publicJson({ terms: [] });
  }
}

async function getMapTrendEditorTerms(env) {
  try {
    const rows = await env.DB.prepare(`
      SELECT slot,label,query,source_label,observed_on,updated_at
        FROM map_trend_terms ORDER BY slot ASC LIMIT ?
    `).bind(MAP_TREND_LIMIT).all();
    return json({ terms: rows.results || [] });
  } catch (error) {
    console.error("map trend editor read failed", safeLogError(error));
    return json({ error: "運営者データを読み込めませんでした" }, 503);
  }
}

async function replaceMapTrendTerms(request, env, me) {
  const parsed = await limitedJson(request, 4_000);
  if (parsed.error) return parsed.error;
  const normalized = normalizeMapTrendTerms(parsed.value.terms);
  if (normalized.error) return json({ error: normalized.error }, 400);
  if (!(await userLimit(env, me.id, "map-trend-editor-hour", hourKey(), 20)))
    return json({ error: "保存回数が多すぎます。少し待ってから再試行してください" }, 429);

  const now = Date.now();
  const terms = normalized.value;
  const statements = [env.DB.prepare("DELETE FROM map_trend_terms")];
  terms.forEach(function (term, index) {
    statements.push(env.DB.prepare(`
      INSERT INTO map_trend_terms
        (slot,label,query,source_label,observed_on,updated_by_firebase_uid,updated_at)
      VALUES (?,?,?,?,?,?,?)
    `).bind(index + 1, term.label, term.query, term.source_label, term.observed_on,
      me._firebase_uid, now));
  });
  statements.push(env.DB.prepare(`
    INSERT INTO map_trend_audit (id,firebase_uid,action,entry_count,created_at)
    VALUES (?,?,?,?,?)
  `).bind(uuid(), me._firebase_uid, "replace", terms.length, now));

  try {
    await env.DB.batch(statements);
    return json({ ok: true, terms: terms.map(function (term, index) {
      return { slot: index + 1, label: term.label, query: term.query,
        source_label: term.source_label, observed_on: term.observed_on, updated_at: now };
    }) });
  } catch (error) {
    console.error("map trend editor write failed", safeLogError(error));
    return json({ error: "運営者データを保存できませんでした" }, 503);
  }
}

async function patchMe(request, env, me) {
  const parsed = await limitedJson(request, 12_000);
  if (parsed.error) return parsed.error;
  if (!(await userLimit(env, me.id, "profile-edits-hour", hourKey(), 30))) {
    return json({ error: "プロフィールの更新回数が多すぎます" }, 429);
  }
  const b = parsed.value;
  const allow = {
    handle: "text", display_name: "text", bio: "text",
    profile_icon: ["pin","camera","mountain","tree","star","moon","wave","flower"],
    default_visibility: ["private", "friends", "public"],
    friend_precision:   ["exact", "approx", "area", "hidden"],
    public_precision:   ["exact", "approx", "area", "hidden"],
    publish_delay_sec: [0, 3600, 10800, 86400], profile_public: "bool"
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
    if (k === "display_name") {
      const value = limitedText(b[k], 60);
      if (value === null) return json({ error: "表示名は60文字までです" }, 413);
      b[k] = value;
    }
    if (k === "bio") {
      const value = limitedText(b[k], 500);
      if (value === null) return json({ error: "自己紹介は500文字までです" }, 413);
      b[k] = value;
    }
    sets.push(k + "=?");
    vals.push(rule === "bool" ? (b[k] ? 1 : 0) : b[k]);
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

async function saveLegalAcceptance(request, env, me) {
  const parsed = await limitedJson(request, 1_000);
  if (parsed.error) return parsed.error;
  if (!(await userLimit(env, me.id, "legal-acceptance-hour", hourKey(), 20))) {
    return json({ error: "同意記録の更新回数が多すぎます" }, 429);
  }
  const termsVersion = String(parsed.value.terms_version || "").trim();
  const privacyVersion = String(parsed.value.privacy_version || "").trim();
  // 形式だけでは、APIを直接呼んで存在しない版への同意を作れてしまう。
  // 配信中の本文と同じ版だけをサーバー側で受理する。
  if (termsVersion !== CURRENT_TERMS_VERSION || privacyVersion !== CURRENT_PRIVACY_VERSION) {
    return json({ error: "現在の規約バージョンと一致しません" }, 409);
  }
  const acceptedAt = Date.parse(String(parsed.value.accepted_at || ""));
  const now = Date.now();
  if (!Number.isFinite(acceptedAt) || acceptedAt < Date.UTC(2026, 0, 1) || acceptedAt > now + 300_000) {
    return json({ error: "同意時刻が不正です" }, 400);
  }
  await env.DB.prepare(`INSERT INTO legal_acceptances
      (user_id,terms_version,privacy_version,accepted_at,recorded_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(user_id,terms_version,privacy_version)
    DO UPDATE SET accepted_at=MIN(legal_acceptances.accepted_at,excluded.accepted_at),
                  recorded_at=excluded.recorded_at`)
    .bind(me.id, termsVersion, privacyVersion, acceptedAt, now).run();
  return json({ ok: true, terms_version: termsVersion, privacy_version: privacyVersion });
}

/* ============================================================
   アカウント削除 / 通報
   ============================================================ */

function tokenProvider(payload) {
  const signIn = String(payload && payload.firebase && payload.firebase.sign_in_provider || "");
  return signIn.includes("apple") ? "apple" : signIn.includes("phone") ? "phone" : "google";
}

async function deleteFirebaseAuthAccount(idToken, env) {
  if (!env.FIREBASE_WEB_API_KEY) return { ok: false, code: "auth_delete_not_configured" };
  try {
    const response = await fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:delete?key=" +
        encodeURIComponent(env.FIREBASE_WEB_API_KEY),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
        signal: AbortSignal.timeout(8_000)
      }
    );
    return response.ok ? { ok: true } : { ok: false, code: "auth_delete_failed" };
  } catch (_) {
    return { ok: false, code: "auth_delete_unavailable" };
  }
}

async function snapshotAccountFiles(env, jobId, userId) {
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO account_deletion_files(job_id,object_key)
      SELECT ?,key_orig FROM photos WHERE user_id=? AND key_orig IS NOT NULL`).bind(jobId, userId),
    env.DB.prepare(`INSERT OR IGNORE INTO account_deletion_files(job_id,object_key)
      SELECT ?,key_view FROM photos WHERE user_id=? AND key_view IS NOT NULL`).bind(jobId, userId),
    env.DB.prepare(`INSERT OR IGNORE INTO account_deletion_files(job_id,object_key)
      SELECT ?,key_thumb FROM photos WHERE user_id=? AND key_thumb IS NOT NULL`).bind(jobId, userId)
  ]);
}

async function processAccountDeletion(env, jobId) {
  const job = await env.DB.prepare(`SELECT id,user_id,status FROM account_deletion_jobs
    WHERE id=? AND status IN ('auth_deleted','data_pending')`).bind(jobId).first();
  if (!job || !job.user_id) return { completed: false, missing: true };
  await snapshotAccountFiles(env, job.id, job.user_id);
  const files = await env.DB.prepare(
    "SELECT object_key FROM account_deletion_files WHERE job_id=? ORDER BY object_key LIMIT 50"
  ).bind(job.id).all();
  for (const row of (files.results || [])) {
    const shared = await env.DB.prepare(`SELECT 1 FROM photos
      WHERE user_id<>?1 AND (key_orig=?2 OR key_view=?2 OR key_thumb=?2) LIMIT 1`)
      .bind(job.user_id, row.object_key).first();
    if (!shared) await env.PHOTOS.delete(row.object_key);
    await env.DB.prepare("DELETE FROM account_deletion_files WHERE job_id=? AND object_key=?")
      .bind(job.id, row.object_key).run();
  }
  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM account_deletion_files WHERE job_id=?"
  ).bind(job.id).first();
  if (Number(remaining && remaining.n || 0) > 0) {
    await env.DB.prepare(`UPDATE account_deletion_jobs
      SET status='data_pending',updated_at=? WHERE id=?`).bind(Date.now(), job.id).run();
    return { completed: false, pending: Number(remaining.n) };
  }

  const now = Date.now();
  // The original reports and places tables predate ON DELETE actions.
  // Clear only references to this account before deleting the users row.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM reports WHERE reporter_id=?1 OR target_user=?1
      OR post_id IN (SELECT id FROM posts WHERE user_id=?1)`).bind(job.user_id),
    env.DB.prepare("UPDATE places SET created_by=NULL WHERE created_by=?").bind(job.user_id)
  ]);
  await env.DB.prepare("DELETE FROM users WHERE id=?").bind(job.user_id).run();
  await env.DB.prepare(`DELETE FROM conversations WHERE NOT EXISTS
    (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=conversations.id)`).run();
  await env.DB.prepare(`UPDATE account_deletion_jobs
    SET user_id=NULL,status='completed',completed_at=?,updated_at=?,last_error=''
    WHERE id=?`).bind(now, now, job.id).run();
  return { completed: true };
}

async function deleteAccount(request, env, me) {
  const parsed = await limitedJson(request, 2_000);
  if (parsed.error) return parsed.error;
  if (parsed.value.confirmation !== "削除")
    return json({ error: "確認欄に「削除」と入力してください", code: "confirmation_required" }, 400);
  if (!(await socialWriteLimit(env, me, "account-delete")) ||
      !(await userLimit(env, me.id, "account-delete-day", dayKey(), 3)))
    return json({ error: "削除操作の回数が多すぎます" }, 429);

  const authorization = request.headers.get("Authorization") || "";
  const idToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const payload = idToken ? await verifyToken(idToken, env.FIREBASE_PROJECT_ID) : null;
  if (!payload || Number(payload.auth_time || 0) * 1000 < Date.now() - 10 * 60 * 1000)
    return json({ error: "安全のため、もう一度ログインしてください", code: "recent_login_required" }, 401);
  const provider = tokenProvider(payload);
  if (provider === "apple" && parsed.value.apple_revoked !== true)
    return json({ error: "Appleとの連携解除を完了してください", code: "apple_revoke_required" }, 409);

  const identity = await env.DB.prepare(
    "SELECT provider_uid FROM identities WHERE user_id=? AND provider=?"
  ).bind(me.id, provider).first();
  if (!identity) return json({ error: "ログイン方法を確認できません" }, 409);
  const existing = await env.DB.prepare(`SELECT id,status FROM account_deletion_jobs
    WHERE user_id=? AND status IN ('prepared','auth_deleted','data_pending') LIMIT 1`)
    .bind(me.id).first();
  if (existing) return json({ error: "削除処理はすでに進行中です", code: "deletion_pending" }, 409);

  const jobId = uuid();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO account_deletion_jobs
    (id,user_id,user_id_hash,provider,provider_uid_hash,status,requested_at,updated_at)
    VALUES (?,?,?,?,?,'prepared',?,?)`)
    .bind(jobId, me.id, await shortHash(me.id), provider,
      await shortHash(identity.provider_uid), now, now).run();

  const authDeleted = await deleteFirebaseAuthAccount(idToken, env);
  if (!authDeleted.ok) {
    await env.DB.prepare(`UPDATE account_deletion_jobs
      SET status='failed',last_error=?,updated_at=? WHERE id=?`)
      .bind(authDeleted.code, Date.now(), jobId).run();
    return json({ error: "ログインアカウントを削除できませんでした。もう一度お試しください",
      code: authDeleted.code }, authDeleted.code === "auth_delete_not_configured" ? 503 : 502);
  }

  await env.DB.batch([
    env.DB.prepare("UPDATE users SET deleted_at=? WHERE id=? AND deleted_at IS NULL").bind(Date.now(), me.id),
    env.DB.prepare(`UPDATE account_deletion_jobs
      SET status='auth_deleted',updated_at=? WHERE id=?`).bind(Date.now(), jobId)
  ]);
  try {
    const result = await processAccountDeletion(env, jobId);
    return json({ ok: true, completed: !!result.completed, job_id: jobId }, result.completed ? 200 : 202);
  } catch (error) {
    await env.DB.prepare(`UPDATE account_deletion_jobs
      SET status='data_pending',last_error=?,updated_at=? WHERE id=?`)
      .bind(safeLogError(error), Date.now(), jobId).run();
    return json({ ok: true, completed: false, job_id: jobId }, 202);
  }
}

async function resumeAccountDeletions(env) {
  const stalePrepared = Date.now() - 24 * 60 * 60 * 1000;
  await env.DB.prepare(`UPDATE users SET deleted_at=?1 WHERE id IN (
    SELECT user_id FROM account_deletion_jobs
     WHERE status='prepared' AND updated_at<?2 AND user_id IS NOT NULL)`)
    .bind(Date.now(), stalePrepared).run();
  await env.DB.prepare(`UPDATE account_deletion_jobs SET status='data_pending',updated_at=?1
    WHERE status='prepared' AND updated_at<?2`).bind(Date.now(), stalePrepared).run();
  const jobs = await env.DB.prepare(`SELECT id FROM account_deletion_jobs
    WHERE status IN ('auth_deleted','data_pending') ORDER BY updated_at LIMIT 2`).all();
  for (const job of (jobs.results || [])) {
    try { await processAccountDeletion(env, job.id); }
    catch (error) {
      await env.DB.prepare(`UPDATE account_deletion_jobs
        SET status='data_pending',last_error=?,updated_at=? WHERE id=?`)
        .bind(safeLogError(error), Date.now(), job.id).run();
    }
  }
}

async function createReport(request, env, me) {
  const parsed = await limitedJson(request, 8_000);
  if (parsed.error) return parsed.error;
  if (!(await socialWriteLimit(env, me, "reports")) ||
      !(await userLimit(env, me.id, "reports-day", dayKey(), 20)))
    return json({ error: "今日の通報回数が上限です" }, 429);
  const b = parsed.value;
  const targetType = String(b.target_type || "");
  const targetId = String(b.target_id || "");
  const reason = String(b.reason || "");
  const details = limitedText(b.details, 500);
  const operationId = String(b.client_operation_id || "");
  if (!["post", "user"].includes(targetType) || !/^[A-Za-z0-9_.-]{1,128}$/.test(targetId) ||
      !["spam", "harassment", "nudity", "violence", "privacy", "other"].includes(reason) ||
      details === null || !/^[A-Za-z0-9_-]{8,80}$/.test(operationId))
    return json({ error: "通報内容を確認してください" }, 400);

  let targetUserId = null;
  if (targetType === "post") {
    const post = await viewablePost(env, me, targetId);
    if (!post) return json({ error: "投稿が見つかりません" }, 404);
    targetUserId = post.user_id;
  } else {
    const user = await env.DB.prepare(
      "SELECT id FROM users WHERE id=? AND deleted_at IS NULL"
    ).bind(targetId).first();
    if (!user) return json({ error: "利用者が見つかりません" }, 404);
    targetUserId = user.id;
  }
  if (targetUserId === me.id) return json({ error: "自分自身は通報できません" }, 400);

  const replay = await env.DB.prepare(
    "SELECT id FROM reports WHERE reporter_id=? AND client_operation_id=?"
  ).bind(me.id, operationId).first();
  if (replay) return json({ ok: true, id: replay.id, replayed: true });
  const now = Date.now();
  const inserted = await env.DB.prepare(`INSERT INTO reports
    (reporter_id,post_id,target_user,reason,detail,status,created_at,client_operation_id,updated_at)
    VALUES (?,?,?,?,?,'open',?,?,?)`)
    .bind(me.id, targetType === "post" ? targetId : null,
      targetType === "user" ? targetUserId : null, reason, details || "",
      now, operationId, now).run();
  return json({ ok: true, id: Number(inserted.meta && inserted.meta.last_row_id || 0) }, 201);
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
  const clientOperationId = b.client_operation_id == null ? null : String(b.client_operation_id);
  if (clientOperationId && !/^[A-Za-z0-9_-]{8,80}$/.test(clientOperationId)) {
    return json({ error: "操作IDが不正です" }, 400);
  }
  if ([title, category, tag, placeName, body, placeIdText].includes(null)) {
    return json({ error: "投稿の文字数が上限を超えています" }, 413);
  }

  if (clientOperationId) {
    const replay = await env.DB.prepare(
      "SELECT id,visibility FROM posts WHERE user_id=? AND client_operation_id=?"
    ).bind(me.id, clientOperationId).first();
    if (replay) return json({ id: replay.id, visibility: replay.visibility, replayed: true });
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
  try { await env.DB.prepare(`
    INSERT INTO posts (
      id,user_id,place_id,title,category,tag,place_name,body,
      lat,lng,approx_lat,approx_lng,area_lat,area_lng,
      fixed_lat,fixed_lng,fixed_label,
      taken_at,created_at,visibility,publish_at,client_operation_id
    ) VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?, ?,?,?,?,?)
  `).bind(
    id, me.id, placeId, title || "", category || "景",
    tag || "", placeName || "", body || "",
    lat, lng, aLat, aLng, rLat, rLng,
    fixedLat, fixedLng, fixedLabel,
    b.taken_at || null, now, vis, now + (me.publish_delay_sec || 0) * 1000,
    clientOperationId
  ).run(); } catch (error) {
    if (clientOperationId) {
      const replay = await env.DB.prepare(
        "SELECT id,visibility FROM posts WHERE user_id=? AND client_operation_id=?"
      ).bind(me.id, clientOperationId).first();
      if (replay) return json({ id: replay.id, visibility: replay.visibility, replayed: true });
    }
    throw error;
  }
  await syncPostHashtags(env, id, now, title, tag, body);

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
  if (["title", "tag", "body"].some(k => k in b)) {
    const current = await env.DB.prepare("SELECT title,tag,body,created_at FROM posts WHERE id=? AND user_id=?")
      .bind(id, me.id).first();
    if (current) await syncPostHashtags(env, id, current.created_at, current.title, current.tag, current.body);
  }
  await announcePostIfReady(env, id);
  return json({ ok: true });
}

async function deletePost(id, env, me) {
  const result = await env.DB.prepare("UPDATE posts SET deleted_at=? WHERE id=? AND user_id=? AND deleted_at IS NULL")
    .bind(Date.now(), id, me.id).run();
  if (!result.meta || result.meta.changes !== 1) return json({ error: "見つかりません" }, 404);
  return json({ ok: true });
}

async function announcePostIfReady(env, postId) {
  const now = Date.now();
  const post = await env.DB.prepare(`
    SELECT p.id,p.user_id,p.title,p.place_name,p.visibility,p.publish_at,p.social_announced_at,
           u.handle,u.display_name
      FROM posts p JOIN users u ON u.id=p.user_id
     WHERE p.id=? AND p.deleted_at IS NULL AND p.visibility<>'private'
       AND p.publish_at<=? AND p.social_announced_at IS NULL
       AND EXISTS (SELECT 1 FROM photos ph WHERE ph.post_id=p.id
         AND ph.key_thumb IS NOT NULL AND ph.moderation_state='ok')
  `).bind(postId, now).first();
  if (!post) return false;
  const notificationInsert = env.DB.prepare(`
    INSERT OR IGNORE INTO notifications
      (id,user_id,actor_id,kind,entity_type,entity_id,dedupe_key,created_at)
    WITH candidates(uid) AS (
      SELECT CASE WHEN requester_id=?1 THEN addressee_id ELSE requester_id END
        FROM friendships WHERE status='accepted' AND (requester_id=?1 OR addressee_id=?1)
      UNION
      SELECT follower_id FROM follows WHERE followee_id=?1 AND ?2='public'
    )
    SELECT lower(hex(randomblob(16))),uid,?1,'post','post',?3,?4,?5
      FROM candidates
     WHERE uid<>?1 AND NOT EXISTS (SELECT 1 FROM blocks b
       WHERE (b.blocker_id=?1 AND b.blocked_id=uid)
          OR (b.blocker_id=uid AND b.blocked_id=?1))
  `).bind(post.user_id, post.visibility, post.id, `post:${post.id}`, now);
  const who = post.display_name || post.handle || "フレンド";
  const body = publicLocationLabel(post.title || post.place_name || "新しい思い出").slice(0, 80);
  const results = await env.DB.batch([
    notificationInsert,
    env.DB.prepare(`
    UPDATE posts SET social_announced_at=? WHERE id=? AND social_announced_at IS NULL
      AND deleted_at IS NULL AND visibility<>'private' AND publish_at<=?
  `).bind(now, post.id, now)
  ]),last = results[results.length - 1];
  if (!last.meta || last.meta.changes !== 1) return false;
  // 通知一覧は全員分をD1へ確実に残す。PushはWorkerの実行時間を守るため
  // 100人ずつに限定し、残りもアプリ内通知では確認できる。
  const recipients = await env.DB.prepare(`
    SELECT user_id AS uid FROM notifications
     WHERE actor_id=? AND dedupe_key=? ORDER BY created_at LIMIT 100
  `).bind(post.user_id, `post:${post.id}`).all();
  const ids = (recipients.results || []).map(row => row.uid);
  for (let at=0; at<ids.length; at+=10) {
    await Promise.allSettled(ids.slice(at, at+10).map(userId =>
      sendPush(env, userId, who + " が思い出を残しました", body, { post: post.id })
    ));
  }
  return true;
}

async function announceReadyPosts(env) {
  const rows = await env.DB.prepare(`
    SELECT id FROM posts WHERE deleted_at IS NULL AND visibility<>'private'
      AND publish_at<=? AND social_announced_at IS NULL
      AND EXISTS (SELECT 1 FROM photos ph WHERE ph.post_id=posts.id
        AND ph.key_thumb IS NOT NULL AND ph.moderation_state='ok')
     ORDER BY publish_at LIMIT 20
  `).bind(Date.now()).all();
  for (const row of (rows.results || [])) await announcePostIfReady(env, row.id);
}

async function ownedPostIds(request, env, me) {
  const parsed = await limitedJson(request, 12_000);
  if (parsed.error) return parsed.error;
  const ids = Array.isArray(parsed.value.ids)
    ? Array.from(new Set(parsed.value.ids.map(String).filter(id => /^[A-Za-z0-9_-]{8,80}$/.test(id)))).slice(0, 99)
    : [];
  if (!ids.length) return json({ ids: [] });
  if (!(await userLimit(env, me.id, "ownership-hour", hourKey(), 20))) {
    return json({ error: "確認回数が多すぎます" }, 429);
  }
  const marks = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id FROM posts WHERE user_id=? AND id IN (${marks})`
  ).bind(me.id, ...ids).all();
  return json({ ids: (rows.results || []).map(row => row.id) });
}

async function deletedPostIds(url, env, me) {
  const raw = String(url.searchParams.get("cursor") || "0:");
  const match = /^(\d{1,16}):(.*)$/.exec(raw);
  if (!match) return json({ error: "カーソルが不正です" }, 400);
  const time = Number(match[1]), id = match[2];
  if (!Number.isSafeInteger(time) || !/^[A-Za-z0-9_-]{0,80}$/.test(id)) {
    return json({ error: "カーソルが不正です" }, 400);
  }
  const rows = await env.DB.prepare(`
    SELECT id,deleted_at FROM posts
     WHERE user_id=?1 AND deleted_at IS NOT NULL
       AND (deleted_at>?2 OR (deleted_at=?2 AND id>?3))
     ORDER BY deleted_at,id LIMIT 100
  `).bind(me.id, time, id).all();
  const out = rows.results || [];
  const last = out[out.length - 1];
  return json({
    deleted: out,
    cursor: last ? `${last.deleted_at}:${last.id}` : raw,
    has_more: out.length === 100
  });
}

async function ownPostArchive(url, env, me) {
  const raw = String(url.searchParams.get("cursor") || "9007199254740991:zzzzzzzz");
  const match = /^(\d{1,16}):(.*)$/.exec(raw);
  if (!match) return json({ error: "カーソルが不正です" }, 400);
  const time = Number(match[1]), id = match[2];
  if (!Number.isSafeInteger(time) || !/^[A-Za-z0-9_-]{0,80}$/.test(id)) {
    return json({ error: "カーソルが不正です" }, 400);
  }
  if (!(await userLimit(env, me.id, "archive-read-hour", hourKey(), 60))) {
    return json({ error: "復元回数が多すぎます" }, 429);
  }
  const rows = await env.DB.prepare(`
    SELECT p.id,p.title,p.category,p.tag,p.place_name,p.taken_at,p.created_at,
           p.visibility,p.lat,p.lng,
           (SELECT ph.id FROM photos ph WHERE ph.post_id=p.id
             ORDER BY ph.sort_order,ph.created_at LIMIT 1) AS photo_id
      FROM posts p
     WHERE p.user_id=?1 AND p.deleted_at IS NULL
       AND (p.created_at<?2 OR (p.created_at=?2 AND p.id<?3))
     ORDER BY p.created_at DESC,p.id DESC LIMIT 100
  `).bind(me.id, time, id).all();
  const out = rows.results || [];
  const last = out[out.length - 1];
  return json({
    posts: out,
    cursor: last ? `${last.created_at}:${last.id}` : raw,
    has_more: out.length === 100
  });
}

/**
 * この範囲で「自分が見てよい投稿」を返す。
 * 座標の出し分けもSQLの中で済ませ、真の座標が外に出ないようにする。
 */
async function listMapPosts(url, env, me) {
  const s = Number(url.searchParams.get("s"));
  const w = Number(url.searchParams.get("w"));
  const n = Number(url.searchParams.get("n"));
  const e = Number(url.searchParams.get("e"));
  if (![s, w, n, e].every(isFinite)) return json({ error: "範囲の指定が不正です" }, 400);
  if (s < -90 || n > 90 || w < -180 || e > 180 || s >= n || w >= e || n - s > 20 || e - w > 20) {
    return json({ error: "地図の範囲が広すぎるか不正です" }, 400);
  }
  if (!(await socialReadLimit(env, me, "map-posts"))) {
    return json({ error: "読み込み回数が多すぎます" }, 429);
  }

  const now = Date.now();
  const requestedLimit = Number(url.searchParams.get("limit") || 100);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(100, Math.trunc(requestedLimit))) : 100;

  const rows = await env.DB.prepare(`
    WITH friend AS (
      SELECT CASE WHEN requester_id=?1 THEN addressee_id ELSE requester_id END AS uid
        FROM friendships
       WHERE status='accepted' AND (requester_id=?1 OR addressee_id=?1)
    )
    SELECT
      p.id, p.user_id, p.title, p.category, p.tag, p.place_name,
      p.taken_at, p.created_at, p.visibility,
      p.lat, p.lng, p.approx_lat, p.approx_lng, p.area_lat, p.area_lng,
      p.fixed_lat, p.fixed_lng,
      (SELECT ph.id FROM photos ph WHERE ph.post_id=p.id
        AND (p.user_id=?1 OR ph.moderation_state='ok')
        ORDER BY ph.sort_order, ph.created_at LIMIT 1) AS photo_id,
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
      id: r.id, title: r.mine ? r.title : publicLocationLabel(r.title), category: r.category, tag: r.tag,
      place_name: r.mine ? r.place_name : publicLocationLabel(r.place_name), taken_at: r.taken_at,
      visibility: r.visibility, mine: !!r.mine,
      photo_id: r.photo_id || null,
      author: { id: r.user_id, name: r.display_name, handle: r.handle },
      lat: c[0], lng: c[1], precision: c[2]
    });
  }
  return json({ count: out.length, posts: out });
}

async function listPostsQuery(request, env, me) {
  const parsed = await limitedJson(request, 2_000);
  if (parsed.error) return parsed.error;
  const url = new URL("https://internal.invalid/posts");
  for (const key of ["s", "w", "n", "e", "limit"]) {
    if (parsed.value[key] !== undefined) url.searchParams.set(key, String(parsed.value[key]));
  }
  return listMapPosts(url, env, me);
}

async function listProfilePosts(handle, url, env, me) {
  if (!(await socialReadLimit(env, me, "profile"))) {
    return json({ error: "読み込み回数が多すぎます" }, 429);
  }
  const requested = Number(url.searchParams.get("limit") || 100);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.trunc(requested))) : 100;
  const now = Date.now();
  const profile = await env.DB.prepare(
    "SELECT id,handle,display_name,bio,profile_public,profile_icon FROM users WHERE handle=? AND deleted_at IS NULL"
  ).bind(handle).first();
  if (!profile) return json({ error: "ユーザーが見つかりません" }, 404);
  if (profile.id !== me.id && await isBlocked(env, me.id, profile.id)) {
    return json({ error: "ユーザーが見つかりません" }, 404);
  }
  const rows = await env.DB.prepare(`
    WITH friend AS (
      SELECT CASE WHEN requester_id=?1 THEN addressee_id ELSE requester_id END AS uid
        FROM friendships WHERE status='accepted' AND (requester_id=?1 OR addressee_id=?1)
    )
    SELECT p.id,p.user_id,p.title,p.category,p.tag,p.place_name,p.taken_at,p.created_at,
           p.visibility,p.lat,p.lng,p.approx_lat,p.approx_lng,p.area_lat,p.area_lng,
           p.fixed_lat,p.fixed_lng,u.display_name,u.handle,u.profile_icon,(p.user_id=?1) AS mine,
           (SELECT ph.id FROM photos ph WHERE ph.post_id=p.id
             AND (p.user_id=?1 OR ph.moderation_state='ok')
             ORDER BY ph.sort_order,ph.created_at LIMIT 1) AS photo_id,
           (SELECT COUNT(*) FROM post_likes l WHERE l.post_id=p.id) AS like_count,
           (SELECT COUNT(*) FROM post_comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comment_count,
           (SELECT COUNT(*) FROM post_flashes x WHERE x.post_id=p.id) AS flash_count,
           EXISTS(SELECT 1 FROM post_likes l WHERE l.post_id=p.id AND l.user_id=?1) AS liked,
           EXISTS(SELECT 1 FROM post_flashes x WHERE x.post_id=p.id AND x.user_id=?1) AS flashed,
           EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=?1 AND f.followee_id=p.user_id) AS following,
           CASE WHEN p.user_id=?1 THEN 'exact'
                WHEN p.fixed_lat IS NOT NULL THEN 'fixed'
                WHEN p.user_id IN (SELECT uid FROM friend) THEN u.friend_precision
                ELSE u.public_precision END AS prec
      FROM posts p JOIN users u ON u.id=p.user_id
     WHERE u.handle=?2 AND p.deleted_at IS NULL
       AND (p.user_id=?1 OR (p.publish_at<=?3 AND
            (p.visibility='public' OR (p.visibility='friends' AND p.user_id IN (SELECT uid FROM friend)))))
       AND NOT EXISTS (
         SELECT 1 FROM blocks b
          WHERE (b.blocker_id=?1 AND b.blocked_id=p.user_id)
             OR (b.blocker_id=p.user_id AND b.blocked_id=?1)
       )
     ORDER BY p.taken_at DESC,p.created_at DESC LIMIT ?4
  `).bind(me.id, handle, now, limit).all();
  const out=[];
  for(const r of rows.results||[]){
    const c=await coordsFor(env,r);
    out.push({id:r.id,title:r.mine?r.title:publicLocationLabel(r.title),category:r.category,tag:r.tag,
      place_name:r.mine?r.place_name:publicLocationLabel(r.place_name),
      taken_at:r.taken_at,visibility:r.visibility,mine:!!r.mine,
      photo_id:r.photo_id||null,
      like_count:Number(r.like_count)||0,comment_count:Number(r.comment_count)||0,
      flash_count:Number(r.flash_count)||0,liked:!!r.liked,flashed:!!r.flashed,following:!!r.following,
      author:{id:r.user_id,name:r.display_name,handle:r.handle,profile_icon:r.profile_icon||"pin"},
      map_available:!!c,
      ...(c?{lat:c[0],lng:c[1],precision:c[2]}:{})});
  }
  return json({
    profile:{
      id:profile.id,
      handle:profile.handle,
      name:profile.display_name,
      profile_icon:profile.profile_icon||"pin",
      bio:(profile.id===me.id||profile.profile_public)?(profile.bio||""):""
    },
    count:out.length,
    posts:out
  });
}

/**
 * 地図の範囲とは独立した、最近の公開・フレンド投稿。
 * 真の座標はここでも返さず、ユーザー設定に応じた座標だけを付ける。
 */
async function listFeed(url, env, me) {
  if (!(await socialReadLimit(env, me, "feed"))) {
    return json({ error: "読み込み回数が多すぎます" }, 429);
  }
  const requested = Number(url.searchParams.get("limit") || 24);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(40, Math.trunc(requested))) : 24;
  const rawQuery = String(url.searchParams.get("q") || "").trim();
  const hashtagOnly = rawQuery.startsWith("#");
  const query = limitedText(rawQuery.replace(/^#/, "").trim(), 40);
  if (query === null) return json({ error: "検索語が長すぎます" }, 400);
  const searchTerm = hashtagOnly ? query.normalize("NFKC").toLocaleLowerCase("ja-JP")
    : query.replace(/[\\%_]/g, "\\$&");
  const followingOnly = url.searchParams.get("mode") === "following";
  const rawCursor = String(url.searchParams.get("cursor") || "9007199254740991:zzzzzzzz");
  const match = /^(\d{1,16}):([A-Za-z0-9_-]{0,80})$/.exec(rawCursor);
  if (!match) return json({ error: "カーソルが不正です" }, 400);
  const cursorTime = Number(match[1]), cursorId = match[2];
  if (!Number.isSafeInteger(cursorTime)) return json({ error: "カーソルが不正です" }, 400);
  const now = Date.now();
  const rows = await env.DB.prepare(`
    WITH friend AS (
      SELECT CASE WHEN requester_id=?1 THEN addressee_id ELSE requester_id END AS uid
        FROM friendships
       WHERE status='accepted' AND (requester_id=?1 OR addressee_id=?1)
    )
    SELECT p.id,p.user_id,p.title,p.category,p.tag,p.place_name,p.body,
           p.taken_at,p.created_at,p.visibility,
           p.lat,p.lng,p.approx_lat,p.approx_lng,p.area_lat,p.area_lng,
           p.fixed_lat,p.fixed_lng,u.display_name,u.handle,u.profile_icon,(p.user_id=?1) AS mine,
           (SELECT ph.id FROM photos ph WHERE ph.post_id=p.id
             AND (p.user_id=?1 OR ph.moderation_state='ok')
             ORDER BY ph.sort_order,ph.created_at LIMIT 1) AS photo_id,
           (SELECT COUNT(*) FROM post_likes l WHERE l.post_id=p.id) AS like_count,
           (SELECT COUNT(*) FROM post_comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comment_count,
           (SELECT COUNT(*) FROM post_flashes x WHERE x.post_id=p.id) AS flash_count,
           EXISTS(SELECT 1 FROM post_likes l WHERE l.post_id=p.id AND l.user_id=?1) AS liked,
           EXISTS(SELECT 1 FROM post_flashes x WHERE x.post_id=p.id AND x.user_id=?1) AS flashed,
           EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=?1 AND f.followee_id=p.user_id) AS following,
           CASE WHEN p.user_id=?1 THEN 'exact'
                WHEN p.fixed_lat IS NOT NULL THEN 'fixed'
                WHEN p.user_id IN (SELECT uid FROM friend) THEN u.friend_precision
                ELSE u.public_precision END AS prec
      FROM posts p JOIN users u ON u.id=p.user_id
     WHERE p.deleted_at IS NULL AND p.publish_at<=?2
       AND (p.user_id=?1 OR p.visibility='public' OR
            (p.visibility='friends' AND p.user_id IN (SELECT uid FROM friend)))
       AND (p.created_at<?3 OR (p.created_at=?3 AND p.id<?4))
       AND (?5='' OR (?6=1 AND EXISTS(SELECT 1 FROM post_hashtags h
              WHERE h.post_id=p.id AND h.tag_key=?5))
            OR (?6=0 AND (p.tag LIKE '%'||?5||'%' ESCAPE '\\'
              OR p.title LIKE '%'||?5||'%' ESCAPE '\\'
              OR p.place_name LIKE '%'||?5||'%' ESCAPE '\\'
              OR p.body LIKE '%'||?5||'%' ESCAPE '\\')))
       AND (?7=0 OR EXISTS(SELECT 1 FROM follows f
              WHERE f.follower_id=?1 AND f.followee_id=p.user_id))
       AND EXISTS (SELECT 1 FROM photos ph WHERE ph.post_id=p.id AND ph.key_thumb IS NOT NULL
         AND ph.moderation_state='ok')
       AND NOT EXISTS (
         SELECT 1 FROM blocks b
          WHERE (b.blocker_id=?1 AND b.blocked_id=p.user_id)
             OR (b.blocker_id=p.user_id AND b.blocked_id=?1)
       )
     ORDER BY p.created_at DESC,p.id DESC LIMIT ?8
  `).bind(me.id, now, cursorTime, cursorId, searchTerm || "", hashtagOnly ? 1 : 0,
    followingOnly ? 1 : 0, limit).all();

  const out=[];
  for (const r of rows.results || []) {
    const c=await coordsFor(env,r);
    out.push({
      id:r.id,title:r.mine?r.title:publicLocationLabel(r.title),category:r.category,tag:r.tag,body:r.body||"",
      place_name:r.mine?r.place_name:publicLocationLabel(r.place_name),taken_at:r.taken_at,created_at:r.created_at,
      visibility:r.visibility,mine:!!r.mine,photo_id:r.photo_id||null,
      like_count:Number(r.like_count)||0,comment_count:Number(r.comment_count)||0,
      flash_count:Number(r.flash_count)||0,liked:!!r.liked,flashed:!!r.flashed,following:!!r.following,
      author:{id:r.user_id,name:r.display_name,handle:r.handle,profile_icon:r.profile_icon||"pin"},
      map_available:!!c,
      ...(c?{lat:c[0],lng:c[1],precision:c[2]}:{})
    });
  }
  const last=(rows.results||[])[(rows.results||[]).length-1];
  return json({
    posts:out,
    cursor:last?`${last.created_at}:${last.id}`:rawCursor,
    has_more:(rows.results||[]).length===limit
  });
}

async function listFeedQuery(request, env, me) {
  const parsed = await limitedJson(request, 2_000);
  if (parsed.error) return parsed.error;
  const url = new URL("https://internal.invalid/feed");
  const value = parsed.value;
  if (value.limit !== undefined) url.searchParams.set("limit", String(value.limit));
  if (value.cursor !== undefined) url.searchParams.set("cursor", String(value.cursor));
  if (value.query !== undefined) url.searchParams.set("q", String(value.query));
  if (value.mode === "following") url.searchParams.set("mode", "following");
  return listFeed(url, env, me);
}

async function coordsFor(env, row) {
  switch (row.prec) {
    case "exact":  return [row.lat, row.lng, "exact"];
    case "fixed":  return [row.fixed_lat, row.fixed_lng, "fixed"];
    case "approx": return [row.approx_lat, row.approx_lng, "approx"];
    case "area":   return [row.area_lat, row.area_lng, "area"];
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
  // WKWebViewやHTTP/2のチャンク転送ではContent-Lengthが付かないことがある。
  // ヘッダーを必須にすると、実データが正常な写真まで411で拒否してしまう。
  // 上限の判定は必ず実際に読み取ったArrayBufferの長さを基準に行う。
  const declaredHeader = request.headers.get("Content-Length");
  const declared = declaredHeader == null ? null : Number(declaredHeader);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) {
    return json({ error: "画像サイズが不正です" }, 400);
  }
  if (declared !== null && declared > maxBytes) return json({ error: "画像が大きすぎます" }, 413);
  if (!(await userLimit(env, me.id, "photo-requests-hour", hourKey(), 80))) {
    return json({ error: "画像の利用上限に達しました" }, 429);
  }
  const bytes = await readBodyLimited(request, maxBytes);
  if (!bytes || !bytes.byteLength || bytes.byteLength > maxBytes) {
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
  if (!(await userLimit(env, me.id, "photo-bytes-day", dayKey(), 300_000_000, bytes.byteLength)) ||
      !(await userLimit(env, me.id, "photo-bytes-total", "all", 5_000_000_000, bytes.byteLength))) {
    return json({ error: "画像の利用上限に達しました" }, 429);
  }

  let moderation = "not-required";
  if (own.visibility !== "private" && (kind === "view" || kind === "thumb")) {
    moderation = await moderateUploadedPhoto(env, me, bytes);
    if (moderation === "bad") {
      // 不適切判定だけは非公開へ倒す。一時的なAPI障害は確認待ちとして保持し、
      // 写真を他人へ返さないままCronで再判定する。
      await env.DB.prepare("UPDATE posts SET visibility='private' WHERE id=? AND user_id=?")
        .bind(postId, me.id).run();
    }
  }

  const key = `u/${me.id}/${postId}/${photoId}-${kind}.jpg`;

  await env.PHOTOS.put(key, bytes, {
    httpMetadata: { contentType: ct }
  });

  const col = kind === "orig" ? "key_orig" : kind === "view" ? "key_view" : "key_thumb";
  const moderationState = (kind === "view" || kind === "thumb") ? moderation : null;
  const moderationCol = kind === "view" ? "moderation_view_state" :
    kind === "thumb" ? "moderation_thumb_state" : null;
  if (exists) {
    if (moderationCol) {
      await env.DB.prepare(
        `UPDATE photos SET ${col}=?,${moderationCol}=?
          WHERE id=? AND user_id=? AND post_id=?`
      ).bind(key, moderationState, photoId, me.id, postId).run();
    } else {
      await env.DB.prepare(
        `UPDATE photos SET ${col}=? WHERE id=? AND user_id=? AND post_id=?`
      ).bind(key, photoId, me.id, postId).run();
    }
  } else {
    try {
      if (moderationCol) {
        await env.DB.prepare(
          `INSERT INTO photos (id,post_id,user_id,${col},${moderationCol},moderation_state,created_at)
           VALUES (?,?,?,?,?,?,?)`
        ).bind(photoId, postId, me.id, key, moderationState, moderationState, Date.now()).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO photos (id,post_id,user_id,${col},moderation_state,created_at) VALUES (?,?,?,?,?,?)`
        ).bind(photoId, postId, me.id, key, null, Date.now()).run();
      }
    } catch (e) {
      // DBへ参照を残せなかった新規オブジェクトは、その場で回収する。
      await env.PHOTOS.delete(key);
      throw e;
    }
  }
  if (moderationCol) {
    await env.DB.prepare(`
      UPDATE photos SET moderation_state=CASE
        WHEN moderation_view_state='bad' OR moderation_thumb_state='bad' THEN 'bad'
        WHEN moderation_view_state='error' OR moderation_thumb_state='error' THEN 'error'
        WHEN key_view IS NOT NULL AND key_thumb IS NOT NULL
          AND moderation_view_state='ok' AND moderation_thumb_state='ok' THEN 'ok'
        ELSE 'not-required' END
       WHERE id=? AND user_id=? AND post_id=?
    `).bind(photoId, me.id, postId).run();
  }
  if (own.visibility !== "private" && (kind === "view" || kind === "thumb") && moderation === "bad") {
    // 並行PATCHとの競合後も、不適切判定の画像を公開状態に残さない。
    await env.DB.prepare("UPDATE posts SET visibility='private' WHERE id=? AND user_id=?")
      .bind(postId, me.id).run();
  }
  if (moderation === "ok") await announcePostIfReady(env, postId);
  return json({ photo_id: photoId, kind, moderation });
}

/** GET /api/photo/{photoId}/{kind} — 見てよい相手かを必ず確かめてから返す */
async function getPhoto(path, env, me) {
  const [, , , photoId, kind] = path.split("/");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(photoId || "") ||
      !["orig", "view", "thumb"].includes(kind)) {
    return json({ error: "見つかりません" }, 404);
  }
  if (!(await userLimit(env, me.id, "photo-reads-hour", hourKey(), 600)) ||
      !(await userLimit(env, me.id, "photo-reads-day", dayKey(), 3000))) {
    return json({ error: "写真の読み込み回数が多すぎます" }, 429);
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
    if (ph.moderation_state !== "ok") return json({ error: "権限がありません" }, 403);
    if (post.publish_at > Date.now() || post.visibility === "private") {
      return json({ error: "権限がありません" }, 403);
    }
    if (post.visibility === "friends" &&
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
    SELECT DISTINCT u.id,u.handle,u.display_name FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.requester_id=?1 THEN f.addressee_id ELSE f.requester_id END
     WHERE f.status='accepted' AND (f.requester_id=?1 OR f.addressee_id=?1)
  `).bind(me.id).all();

  const inc = await env.DB.prepare(`
    SELECT DISTINCT u.id,u.handle,u.display_name FROM friendships f
      JOIN users u ON u.id=f.requester_id
     WHERE f.status='pending' AND f.addressee_id=?1
  `).bind(me.id).all();

  return { friends: acc.results || [], incoming: inc.results || [] };
}

async function friendRequest(request, env, me) {
  const parsed = await limitedJson(request, 4_000);
  if (parsed.error) return parsed.error;
  const handle = limitedText(parsed.value.handle, 30);
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(handle))
    return json({ error: "IDを確認してください" }, 400);
  if (!(await socialWriteLimit(env, me, "friend-request")) ||
      !(await userLimit(env, me.id, "friend_request", dayKey(), 40, 1)) ||
      !(await atomicLimit(env, "friend_request_global_day_" + dayKey(), 100_000, 1)))
    return json({ error: "申請回数が多すぎます" }, 429);
  const target = await env.DB.prepare("SELECT id FROM users WHERE handle=? AND deleted_at IS NULL")
    .bind(handle).first();
  if (!target) return json({ error: "そのIDのユーザーはいません" }, 404);
  if (target.id === me.id) return json({ error: "自分には申請できません" }, 400);
  if (await isBlocked(env, me.id, target.id)) return json({ error: "申請できません" }, 403);

  const now = Date.now();
  const current = await env.DB.prepare(`
    SELECT id,status,requester_id,addressee_id FROM friendships
     WHERE (requester_id=?1 AND addressee_id=?2) OR (requester_id=?2 AND addressee_id=?1)
     ORDER BY status='accepted' DESC,updated_at DESC LIMIT 1
  `).bind(me.id, target.id).first();
  if (current && current.status === "accepted") return json({ ok: true, status: "accepted" });
  if (current && current.requester_id === me.id && current.status === "pending")
    return json({ ok: true, status: "pending" });
  // 相手からの申請が既にあれば、その場で成立させる
  const rev = current && current.requester_id === target.id && current.status === "pending" ? current : null;
  if (rev) {
    await env.DB.prepare("UPDATE friendships SET status='accepted',updated_at=? WHERE id=?")
      .bind(now, rev.id).run();
    return json({ ok: true, status: "accepted" });
  }

  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM friendships WHERE requester_id=? AND status='pending'"
  ).bind(me.id).first();
  if (Number(pending && pending.n || 0) >= 500)
    return json({ error: "未回答の申請が多すぎます" }, 409);

  await env.DB.prepare(`
    INSERT INTO friendships (requester_id,addressee_id,status,created_at,updated_at)
    VALUES (?,?,'pending',?,?)
    ON CONFLICT(requester_id,addressee_id) DO UPDATE SET status='pending',updated_at=?
      WHERE friendships.status<>'accepted'
  `).bind(me.id, target.id, now, now, now).run();
  return json({ ok: true, status: "pending" });
}

async function friendAccept(request, env, me) {
  const parsed = await limitedJson(request, 4_000);
  if (parsed.error) return parsed.error;
  const user_id = String(parsed.value.user_id || "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(user_id))
    return json({ error: "対象が不正です" }, 400);
  if (!(await socialWriteLimit(env, me, "friend-accept")) ||
      !(await userLimit(env, me.id, "friend_accept", dayKey(), 200, 1)) ||
      !(await atomicLimit(env, "friend_accept_global_day_" + dayKey(), 100_000, 1)))
    return json({ error: "操作回数が多すぎます" }, 429);
  const r = await env.DB.prepare(`
    UPDATE friendships SET status='accepted',updated_at=?
     WHERE requester_id=? AND addressee_id=? AND status='pending'
       AND NOT EXISTS (SELECT 1 FROM blocks b
         WHERE (b.blocker_id=?2 AND b.blocked_id=?3)
            OR (b.blocker_id=?3 AND b.blocked_id=?2))
  `).bind(Date.now(), user_id, me.id).run();
  return json({ ok: true, changed: r.meta ? r.meta.changes : 0 });
}

async function blockUser(request, env, me) {
  const parsed = await limitedJson(request, 4_000);
  if (parsed.error) return parsed.error;
  const user_id = String(parsed.value.user_id || "");
  if (!user_id || user_id === me.id) return json({ error: "対象が不正です" }, 400);
  if (!(await socialWriteLimit(env, me, "block")))
    return json({ error: "操作回数が多すぎます" }, 429);
  const target = await env.DB.prepare(
    "SELECT id FROM users WHERE id=? AND deleted_at IS NULL"
  ).bind(user_id).first();
  if (!target) return json({ error: "見つかりません" }, 404);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO blocks (blocker_id,blocked_id,created_at) VALUES (?,?,?)")
      .bind(me.id, user_id, now),
    env.DB.prepare(`UPDATE friendships SET status='rejected',updated_at=?
       WHERE (requester_id=?1 AND addressee_id=?2) OR (requester_id=?2 AND addressee_id=?1)`)
      .bind(now, me.id, user_id),
    env.DB.prepare("DELETE FROM follows WHERE (follower_id=?1 AND followee_id=?2) OR (follower_id=?2 AND followee_id=?1)")
      .bind(me.id, user_id),
    env.DB.prepare(`DELETE FROM notifications
      WHERE (user_id=?1 AND actor_id=?2) OR (user_id=?2 AND actor_id=?1)`)
      .bind(me.id, user_id),
    env.DB.prepare(`UPDATE conversation_members SET hidden_at=?3
      WHERE user_id IN (?1,?2) AND conversation_id IN (
        SELECT a.conversation_id FROM conversation_members a
          JOIN conversation_members b ON b.conversation_id=a.conversation_id
         WHERE a.user_id=?1 AND b.user_id=?2
      )`).bind(me.id, user_id, now)
  ]);
  return json({ ok: true });
}


/* ============================================================
   ソーシャル機能

   posts / friendships / blocks の判定を必ず先に通す。
   画面側の非表示や、IDを知っていることは権限として扱わない。
   ============================================================ */

async function viewablePost(env, me, postId) {
  const post = await env.DB.prepare(`
    SELECT p.id,p.user_id,p.title,p.tag,p.body,p.place_name,p.visibility,p.publish_at,
           p.deleted_at,u.handle,u.display_name
      FROM posts p JOIN users u ON u.id=p.user_id
     WHERE p.id=? AND p.deleted_at IS NULL AND u.deleted_at IS NULL
  `).bind(postId).first();
  if (!post || await isBlocked(env, me.id, post.user_id)) return null;
  if (post.user_id === me.id) return post;
  if (post.publish_at > Date.now() || post.visibility === "private") return null;
  if (post.visibility === "friends" && !(await areFriends(env, me.id, post.user_id))) return null;
  return post;
}

function hashtagRows(...values) {
  const seen = new Set(), out = [];
  const text = values.map(v => String(v || "")).join(" ");
  for (const match of text.matchAll(/#([^\s#]{1,30})/gu)) {
    const label = match[1].replace(/[.,!?、。！？：:;；)）\]】]+$/u, "").normalize("NFKC");
    if (!label) continue;
    const key = label.toLocaleLowerCase("ja-JP");
    if (!seen.has(key)) { seen.add(key); out.push({ key, label: "#" + label }); }
    if (out.length >= 12) break;
  }
  return out;
}

async function syncPostHashtags(env, postId, createdAt, ...values) {
  const rows = hashtagRows(...values);
  const statements = [env.DB.prepare("DELETE FROM post_hashtags WHERE post_id=?").bind(postId)];
  for (const row of rows) {
    statements.push(env.DB.prepare(
      "INSERT INTO post_hashtags (post_id,tag_key,tag_label,created_at) VALUES (?,?,?,?)"
    ).bind(postId, row.key, row.label, createdAt || Date.now()));
  }
  await env.DB.batch(statements);
}

async function putNotification(env, userId, actorId, kind, entityType, entityId, dedupeKey) {
  if (!userId || userId === actorId) return false;
  if (actorId && await isBlocked(env, userId, actorId)) return false;
  dedupeKey=dedupeKey||`${kind}:${entityType||"none"}:${entityId||"none"}:${actorId||"system"}`;
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO notifications
      (id,user_id,actor_id,kind,entity_type,entity_id,dedupe_key,created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).bind(uuid(), userId, actorId || null, kind, entityType || null,
    entityId || null, dedupeKey, Date.now()).run();
  return !!(result.meta && result.meta.changes === 1);
}

async function putLike(postId, env, me) {
  if (!(await socialWriteLimit(env, me, "likes")))
    return json({ error: "操作回数が多すぎます" }, 429);
  const post = await viewablePost(env, me, postId);
  if (!post) return json({ error: "見つかりません" }, 404);
  const existing = await env.DB.prepare(
    "SELECT 1 FROM post_likes WHERE post_id=? AND user_id=?"
  ).bind(postId, me.id).first();
  if (existing) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM post_likes WHERE post_id=?")
      .bind(postId).first();
    return json({ ok: true, liked: true, count: Number(count && count.n) || 0, replayed: true });
  }
  if (!(await userLimit(env, me.id, "likes-day", dayKey(), 200, 1)) ||
      !(await atomicLimit(env, "likes_global_day_" + dayKey(), 200_000, 1)))
    return json({ error: "今日のいいね操作が上限です" }, 429);
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO post_likes (post_id,user_id,created_at) VALUES (?,?,?)"
  ).bind(postId, me.id, Date.now()).run();
  if (result.meta && result.meta.changes === 1) {
    const fresh = await putNotification(env, post.user_id, me.id, "like", "post", postId,
      `like:${postId}:${me.id}`);
    if (fresh) await sendPush(env, post.user_id,
      me.display_name || me.handle || "誰か", "あなたの思い出にいいねしました", { post: postId });
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM post_likes WHERE post_id=?")
    .bind(postId).first();
  return json({ ok: true, liked: true, count: Number(count && count.n) || 0 });
}

async function deleteLike(postId, env, me) {
  if (!(await socialWriteLimit(env, me, "likes")))
    return json({ error: "操作回数が多すぎます" }, 429);
  const post = await viewablePost(env, me, postId);
  if (!post) return json({ error: "見つかりません" }, 404);
  const existing = await env.DB.prepare(
    "SELECT 1 FROM post_likes WHERE post_id=? AND user_id=?"
  ).bind(postId, me.id).first();
  if (existing && (!(await userLimit(env, me.id, "likes-day", dayKey(), 200, 1)) ||
      !(await atomicLimit(env, "likes_global_day_" + dayKey(), 200_000, 1))))
    return json({ error: "今日のいいね操作が上限です" }, 429);
  await env.DB.prepare("DELETE FROM post_likes WHERE post_id=? AND user_id=?").bind(postId, me.id).run();
  // 通知のdedupe行は残し、解除→再いいねで同じ通知とpushを再生成させない。
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM post_likes WHERE post_id=?")
    .bind(postId).first();
  return json({ ok: true, liked: false, count: Number(count && count.n) || 0 });
}

async function flashPost(postId, env, me) {
  // 再送リクエストも含め、認証済み利用者ごとの短時間連打を先に止める。
  if (!(await socialWriteLimit(env, me, "flash")))
    return json({ error: "操作回数が多すぎます" }, 429);
  const post = await viewablePost(env, me, postId);
  if (!post) return json({ error: "見つかりません" }, 404);
  // ランダムな相手へ届ける操作なので、フレンド限定・非公開投稿には使わせない。
  if (post.visibility !== "public" || post.publish_at > Date.now())
    return json({ error: "公開済みの思い出だけフラッシュできます" }, 409);
  const ready = await env.DB.prepare(`
    SELECT 1 FROM photos
     WHERE post_id=? AND key_thumb IS NOT NULL AND moderation_state='ok' LIMIT 1
  `).bind(postId).first();
  if (!ready) return json({ error: "写真の安全確認が完了していません" }, 409);

  const replay = await env.DB.prepare(
    "SELECT recipient_count FROM post_flashes WHERE post_id=? AND user_id=?"
  ).bind(postId, me.id).first();
  if (replay) {
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM post_flashes WHERE post_id=?")
      .bind(postId).first();
    return json({ ok: true, flashed: true, recipient_count: Number(replay.recipient_count) || 0,
      flash_count: Number(total && total.n) || 0, replayed: true });
  }

  if (!(await userLimit(env, me.id, "flash-day", dayKey(), 10, 1)) ||
      !(await atomicLimit(env, "flash_global_day_" + dayKey(), 50_000, 1)))
    return json({ error: "今日のフラッシュ回数が上限です" }, 429);

  const now = Date.now();
  const claimed = await env.DB.prepare(`
    INSERT OR IGNORE INTO post_flashes (post_id,user_id,recipient_count,created_at)
    VALUES (?,?,0,?)
  `).bind(postId, me.id, now).run();
  if (!claimed.meta || claimed.meta.changes !== 1) {
    const existing = await env.DB.prepare(
      "SELECT recipient_count FROM post_flashes WHERE post_id=? AND user_id=?"
    ).bind(postId, me.id).first();
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM post_flashes WHERE post_id=?")
      .bind(postId).first();
    return json({ ok: true, flashed: true,
      recipient_count: Number(existing && existing.recipient_count) || 0,
      flash_count: Number(total && total.n) || 0, replayed: true });
  }

  try {
    // Firebase UIDの主キー順をランダムな位置から循環して読み、全ユーザーのRANDOM() sortを避ける。
    const pivot = uuid().replaceAll("-", "");
  async function candidatesAfter(boundary, limit) {
    const rows = await env.DB.prepare(`
      SELECT u.id FROM users u
       WHERE u.deleted_at IS NULL AND u.id<>?1 AND u.id<>?2 AND u.id>=?3
         AND NOT EXISTS (SELECT 1 FROM blocks b
           WHERE (b.blocker_id=?1 AND b.blocked_id=u.id)
              OR (b.blocker_id=u.id AND b.blocked_id=?1))
         AND NOT EXISTS (SELECT 1 FROM blocks b
           WHERE (b.blocker_id=?2 AND b.blocked_id=u.id)
              OR (b.blocker_id=u.id AND b.blocked_id=?2))
       ORDER BY u.id LIMIT ?4
    `).bind(me.id, post.user_id, boundary, limit).all();
    return rows.results || [];
  }
  async function candidatesBefore(boundary, limit) {
    if (limit <= 0) return [];
    const rows = await env.DB.prepare(`
      SELECT u.id FROM users u
       WHERE u.deleted_at IS NULL AND u.id<>?1 AND u.id<>?2 AND u.id<?3
         AND NOT EXISTS (SELECT 1 FROM blocks b
           WHERE (b.blocker_id=?1 AND b.blocked_id=u.id)
              OR (b.blocker_id=u.id AND b.blocked_id=?1))
         AND NOT EXISTS (SELECT 1 FROM blocks b
           WHERE (b.blocker_id=?2 AND b.blocked_id=u.id)
              OR (b.blocker_id=u.id AND b.blocked_id=?2))
       ORDER BY u.id LIMIT ?4
    `).bind(me.id, post.user_id, boundary, limit).all();
    return rows.results || [];
  }
  let recipients = await candidatesAfter(pivot, 5);
  if (recipients.length < 5) {
    const wrapped = await candidatesBefore(pivot, 5 - recipients.length);
    recipients = recipients.concat(wrapped);
  }

  const statements = [env.DB.prepare(
    "UPDATE post_flashes SET recipient_count=? WHERE post_id=? AND user_id=?"
  ).bind(recipients.length, postId, me.id)];
  for (const recipient of recipients) {
    statements.push(env.DB.prepare(`
      INSERT OR IGNORE INTO notifications
        (id,user_id,actor_id,kind,entity_type,entity_id,dedupe_key,created_at)
      VALUES (?,?,?,'flash','post',?,?,?)
    `).bind(uuid(), recipient.id, me.id, postId, `flash:${postId}:${me.id}`, now));
  }
  const results = await env.DB.batch(statements);
  const fresh = recipients.filter((_, index) =>
    results[index + 1] && results[index + 1].meta && results[index + 1].meta.changes === 1);
  await Promise.all(fresh.map(recipient => sendPush(env, recipient.id,
    me.display_name || me.handle || "誰か", "公開された思い出がフラッシュで届きました", { post: postId })));
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM post_flashes WHERE post_id=?")
    .bind(postId).first();
    return json({ ok: true, flashed: true, recipient_count: recipients.length,
      flash_count: Number(total && total.n) || 0 });
  } catch (error) {
    // 候補検索や通知保存が失敗した場合、0人の処理済み記録だけを戻して安全に再試行できるようにする。
    try {
      await env.DB.prepare(`DELETE FROM post_flashes
        WHERE post_id=? AND user_id=? AND recipient_count=0`).bind(postId, me.id).run();
    } catch (_) { /* 元のエラーを優先する */ }
    throw error;
  }
}

const SOCIAL_CURSOR_MAX = "9007199254740991:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
function socialCursor(url) {
  let raw = String(url.searchParams.get("cursor") || url.searchParams.get("before") || SOCIAL_CURSOR_MAX);
  // 旧クライアントの時刻だけのbeforeも、安全な複合カーソルへ読み替える。
  if (/^\d{1,16}$/.test(raw)) raw += ":zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
  const match = /^(\d{1,16}):([A-Za-z0-9_-]{0,80})$/.exec(raw);
  const time = match ? Number(match[1]) : NaN;
  if (!match || !Number.isSafeInteger(time)) return null;
  return { raw, time, id: match[2] };
}

async function listComments(postId, url, env, me) {
  const post = await viewablePost(env, me, postId);
  if (!post) return json({ error: "見つかりません" }, 404);
  if (!(await socialReadLimit(env, me, "comments")))
    return json({ error: "読み込み回数が多すぎます" }, 429);
  const cursor = socialCursor(url);
  if (!cursor) return json({ error: "カーソルが不正です" }, 400);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 30) | 0));
  const rows = await env.DB.prepare(`
    SELECT c.id,c.body,c.created_at,c.updated_at,c.user_id,u.handle,u.display_name
      FROM post_comments c JOIN users u ON u.id=c.user_id
     WHERE c.post_id=?1 AND c.deleted_at IS NULL
       AND (c.created_at<?2 OR (c.created_at=?2 AND c.id<?3))
       AND NOT EXISTS (SELECT 1 FROM blocks b
         WHERE (b.blocker_id=?4 AND b.blocked_id=c.user_id)
            OR (b.blocker_id=c.user_id AND b.blocked_id=?4))
     ORDER BY c.created_at DESC,c.id DESC LIMIT ?5
  `).bind(postId, cursor.time, cursor.id, me.id, limit).all();
  const descending = rows.results || [], oldest = descending[descending.length - 1];
  const comments = descending.slice().reverse().map(r => ({
    id: r.id, body: r.body, created_at: r.created_at, mine: r.user_id === me.id,
    author: { id: r.user_id, handle: r.handle, name: r.display_name }
  }));
  return json({ comments, cursor: oldest ? `${oldest.created_at}:${oldest.id}` : cursor.raw,
    has_more: descending.length === limit });
}

async function createComment(postId, request, env, me) {
  const parsed = await limitedJson(request, 6_000);
  if (parsed.error) return parsed.error;
  const body = limitedText(parsed.value.body, 1000);
  if (!body) return json({ error: "コメントを入力してください" }, 400);
  const operationId = String(parsed.value.client_operation_id || "");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(operationId))
    return json({ error: "操作IDが不正です" }, 400);
  const post = await viewablePost(env, me, postId);
  if (!post) return json({ error: "見つかりません" }, 404);
  const replay = await env.DB.prepare(`SELECT id,body,created_at FROM post_comments
    WHERE post_id=? AND user_id=? AND client_operation_id=?`)
    .bind(postId, me.id, operationId).first();
  if (replay) return replay.body === body
    ? json({ ...replay, mine: true, replayed: true,
        author: { id: me.id, handle: me.handle, name: me.display_name } })
    : json({ error: "同じ操作IDの内容が一致しません" }, 409);
  if (!(await socialWriteLimit(env, me, "comments")) ||
      !(await userLimit(env, me.id, "comments-day", dayKey(), 200)))
    return json({ error: "コメント回数が多すぎます" }, 429);
  const id = uuid(), now = Date.now();
  try {
    await env.DB.prepare(`
      INSERT INTO post_comments (id,post_id,user_id,body,client_operation_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
    `).bind(id, postId, me.id, body, operationId, now, now).run();
  } catch (error) {
    const existing = await env.DB.prepare(`SELECT id,body,created_at FROM post_comments
      WHERE post_id=? AND user_id=? AND client_operation_id=?`)
      .bind(postId, me.id, operationId).first();
    if (existing) return existing.body === body
      ? json({ ...existing, mine: true, replayed: true,
          author: { id: me.id, handle: me.handle, name: me.display_name } })
      : json({ error: "同じ操作IDの内容が一致しません" }, 409);
    throw error;
  }
  const fresh = await putNotification(env, post.user_id, me.id, "comment", "post", postId,
    `comment:${id}`);
  if (fresh) await sendPush(env, post.user_id, me.display_name || me.handle || "誰か",
    "新しいコメントが届きました", { post: postId, comment: id });
  return json({ id, body, created_at: now, mine: true,
    author: { id: me.id, handle: me.handle, name: me.display_name } }, 201);
}

async function deleteComment(postId, commentId, env, me) {
  const row = await env.DB.prepare(`
    SELECT c.user_id,p.user_id AS post_owner FROM post_comments c
      JOIN posts p ON p.id=c.post_id
     WHERE c.id=? AND c.post_id=? AND c.deleted_at IS NULL
  `).bind(commentId, postId).first();
  if (!row) return json({ error: "見つかりません" }, 404);
  if (row.user_id !== me.id && row.post_owner !== me.id)
    return json({ error: "権限がありません" }, 403);
  await env.DB.batch([
    env.DB.prepare("UPDATE post_comments SET deleted_at=?,body='' WHERE id=? AND post_id=?")
      .bind(Date.now(), commentId, postId),
    env.DB.prepare("DELETE FROM notifications WHERE dedupe_key=?").bind(`comment:${commentId}`)
  ]);
  return json({ ok: true });
}

async function trendingHashtags(url, env, me) {
  if (!(await socialReadLimit(env, me, "hashtags")))
    return json({ error: "読み込み回数が多すぎます" }, 429);
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const rows = await env.DB.prepare(`
    SELECT h.tag_key,MAX(h.tag_label) AS label,COUNT(*) AS count
      FROM post_hashtags h JOIN posts p ON p.id=h.post_id
     WHERE h.created_at>=?1 AND p.deleted_at IS NULL AND p.publish_at<=?2
       AND p.visibility='public'
       AND NOT EXISTS (SELECT 1 FROM blocks b
         WHERE (b.blocker_id=?3 AND b.blocked_id=p.user_id)
            OR (b.blocker_id=p.user_id AND b.blocked_id=?3))
     GROUP BY h.tag_key ORDER BY count DESC,MAX(h.created_at) DESC LIMIT 12
  `).bind(since, Date.now(), me.id).all();
  return json({ tags: (rows.results || []).map(r => ({ label: r.label, count: Number(r.count) })) });
}

async function listFollows(url, env, me) {
  if (!(await socialReadLimit(env, me, "follows")))
    return json({ error: "読み込み回数が多すぎます" }, 429);
  const handle = String(url.searchParams.get("user") || me.handle || "");
  const user = await env.DB.prepare(
    "SELECT id,handle FROM users WHERE handle=? AND deleted_at IS NULL"
  ).bind(handle).first();
  if (!user || await isBlocked(env, me.id, user.id)) return json({ error: "見つかりません" }, 404);
  const counts = await env.DB.prepare(`
    SELECT (SELECT COUNT(*) FROM follows WHERE followee_id=?1) AS followers,
           (SELECT COUNT(*) FROM follows WHERE follower_id=?1) AS following,
           EXISTS(SELECT 1 FROM follows WHERE follower_id=?2 AND followee_id=?1) AS followed
  `).bind(user.id, me.id).first();
  return json({ user: user.handle, followers: Number(counts.followers) || 0,
    following: Number(counts.following) || 0, followed: !!counts.followed });
}

async function putFollow(handle, env, me) {
  if (!(await socialWriteLimit(env, me, "follows")))
    return json({ error: "操作回数が多すぎます" }, 429);
  const target = await env.DB.prepare(
    "SELECT id,handle,display_name FROM users WHERE handle=? AND deleted_at IS NULL"
  ).bind(handle).first();
  if (!target) return json({ error: "見つかりません" }, 404);
  if (target.id === me.id) return json({ error: "自分はフォローできません" }, 400);
  if (await isBlocked(env, me.id, target.id)) return json({ error: "操作できません" }, 403);
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO follows (follower_id,followee_id,created_at) VALUES (?,?,?)"
  ).bind(me.id, target.id, Date.now()).run();
  if (result.meta && result.meta.changes === 1) {
    const fresh = await putNotification(env, target.id, me.id, "follow", "user", me.id,
      `follow:${me.id}`);
    if (fresh) await sendPush(env, target.id, me.display_name || me.handle || "誰か",
      "あなたをフォローしました", { profile: me.handle || "" });
  }
  return json({ ok: true, followed: true });
}

async function deleteFollow(handle, env, me) {
  if (!(await socialWriteLimit(env, me, "follows")))
    return json({ error: "操作回数が多すぎます" }, 429);
  const target = await env.DB.prepare("SELECT id FROM users WHERE handle=? AND deleted_at IS NULL")
    .bind(handle).first();
  if (!target) return json({ error: "見つかりません" }, 404);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM follows WHERE follower_id=? AND followee_id=?").bind(me.id, target.id),
    env.DB.prepare("DELETE FROM notifications WHERE user_id=? AND dedupe_key=?")
      .bind(target.id, `follow:${me.id}`)
  ]);
  return json({ ok: true, followed: false });
}

async function listNotifications(url, env, me) {
  if (!(await socialReadLimit(env, me, "notifications")))
    return json({ error: "読み込み回数が多すぎます" }, 429);
  const cursor = socialCursor(url);
  if (!cursor) return json({ error: "カーソルが不正です" }, 400);
  const rows = await env.DB.prepare(`
    SELECT n.id,n.kind,n.entity_type,n.entity_id,n.created_at,n.read_at,
           u.id AS actor_id,u.handle,u.display_name
      FROM notifications n LEFT JOIN users u ON u.id=n.actor_id
     WHERE n.user_id=?1
       AND (n.created_at<?2 OR (n.created_at=?2 AND n.id<?3))
       AND (n.actor_id IS NULL OR NOT EXISTS (SELECT 1 FROM blocks b
         WHERE (b.blocker_id=?1 AND b.blocked_id=n.actor_id)
            OR (b.blocker_id=n.actor_id AND b.blocked_id=?1)))
     ORDER BY n.created_at DESC,n.id DESC LIMIT 50
  `).bind(me.id, cursor.time, cursor.id).all();
  const items = (rows.results || []).map(r => ({ id: r.id, kind: r.kind,
    entity_type: r.entity_type, entity_id: r.entity_id, created_at: r.created_at,
    read: !!r.read_at, actor: r.actor_id ? { id: r.actor_id, handle: r.handle, name: r.display_name } : null }));
  const oldest = (rows.results || [])[(rows.results || []).length - 1];
  return json({ notifications: items,
    cursor: oldest ? `${oldest.created_at}:${oldest.id}` : cursor.raw,
    has_more: items.length === 50 });
}

async function readNotifications(request, env, me) {
  if (!(await socialWriteLimit(env, me, "notification-read")))
    return json({ error: "操作回数が多すぎます" }, 429);
  const parsed = await limitedJson(request, 12_000);
  if (parsed.error) return parsed.error;
  const now = Date.now();
  if (parsed.value.all === true) {
    await env.DB.prepare("UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL")
      .bind(now, me.id).run();
  } else {
    const ids = Array.isArray(parsed.value.ids) ? Array.from(new Set(parsed.value.ids.map(String)
      .filter(id => /^[A-Za-z0-9_-]{8,80}$/.test(id)))).slice(0, 100) : [];
    if (!ids.length) return json({ error: "通知を指定してください" }, 400);
    const marks = ids.map(() => "?").join(",");
    await env.DB.prepare(`UPDATE notifications SET read_at=? WHERE user_id=? AND id IN (${marks})`)
      .bind(now, me.id, ...ids).run();
  }
  return json({ ok: true });
}

async function unreadSummary(env, me) {
  if (!(await socialReadLimit(env, me, "unread")))
    return json({ error: "読み込み回数が多すぎます" }, 429);
  const row = await env.DB.prepare(`
    SELECT (SELECT COUNT(*) FROM notifications n WHERE n.user_id=?1 AND n.read_at IS NULL
              AND n.kind<>'message'
              AND (n.actor_id IS NULL OR NOT EXISTS (SELECT 1 FROM blocks b
                WHERE (b.blocker_id=?1 AND b.blocked_id=n.actor_id)
                   OR (b.blocker_id=n.actor_id AND b.blocked_id=?1)))) AS notifications,
           (SELECT COUNT(*) FROM messages m JOIN conversation_members cm
              ON cm.conversation_id=m.conversation_id
             WHERE cm.user_id=?1 AND m.sender_id<>?1 AND m.deleted_at IS NULL
               AND cm.hidden_at IS NULL
               AND (m.created_at>cm.last_read_at OR
                    (m.created_at=cm.last_read_at AND m.id>cm.last_read_id))
               AND NOT EXISTS (SELECT 1 FROM blocks b
                 WHERE (b.blocker_id=?1 AND b.blocked_id=m.sender_id)
                    OR (b.blocker_id=m.sender_id AND b.blocked_id=?1))) AS messages
  `).bind(me.id).first();
  return json({ notifications: Number(row.notifications) || 0, messages: Number(row.messages) || 0 });
}

function directPair(a, b) { return [a, b].sort().join(":"); }

async function conversationMember(env, conversationId, userId) {
  return await env.DB.prepare(`
    SELECT cm.conversation_id,cm.last_read_at,cm.last_read_id FROM conversation_members cm
     WHERE cm.conversation_id=? AND cm.user_id=? AND cm.hidden_at IS NULL
  `).bind(conversationId, userId).first();
}

async function createConversation(request, env, me) {
  if (!(await socialWriteLimit(env, me, "conversations")))
    return json({ error: "操作回数が多すぎます" }, 429);
  const parsed = await limitedJson(request, 4_000);
  if (parsed.error) return parsed.error;
  const userId = String(parsed.value.user_id || "");
  const handle = String(parsed.value.handle || "");
  const target = userId
    ? await env.DB.prepare("SELECT id,handle,display_name FROM users WHERE id=? AND deleted_at IS NULL").bind(userId).first()
    : await env.DB.prepare("SELECT id,handle,display_name FROM users WHERE handle=? AND deleted_at IS NULL").bind(handle).first();
  if (!target || target.id === me.id) return json({ error: "相手を確認できません" }, 400);
  if (await isBlocked(env, me.id, target.id) || !(await areFriends(env, me.id, target.id)))
    return json({ error: "チャットはフレンドとのみ開始できます" }, 403);
  const pair = directPair(me.id, target.id), now = Date.now();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO conversations (id,pair_key,created_at,updated_at) VALUES (?,?,?,?)
  `).bind(uuid(), pair, now, now).run();
  const conversation = await env.DB.prepare("SELECT id FROM conversations WHERE pair_key=?")
    .bind(pair).first();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO conversation_members (conversation_id,user_id,joined_at,last_read_at,hidden_at)
      VALUES (?,?,?,?,NULL) ON CONFLICT(conversation_id,user_id) DO UPDATE SET hidden_at=NULL`)
      .bind(conversation.id, me.id, now, now),
    env.DB.prepare(`INSERT INTO conversation_members (conversation_id,user_id,joined_at,last_read_at,hidden_at)
      VALUES (?,?,?,?,NULL) ON CONFLICT(conversation_id,user_id) DO UPDATE SET hidden_at=NULL`)
      .bind(conversation.id, target.id, now, 0)
  ]);
  return json({ id: conversation.id, person: target });
}

async function listConversations(env, me) {
  if (!(await socialReadLimit(env, me, "conversations")))
    return json({ error: "読み込み回数が多すぎます" }, 429);
  const rows = await env.DB.prepare(`
    SELECT c.id,c.updated_at,u.id AS user_id,u.handle,u.display_name,
           (SELECT body FROM messages m WHERE m.conversation_id=c.id AND m.deleted_at IS NULL
             ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_body,
           (SELECT created_at FROM messages m WHERE m.conversation_id=c.id AND m.deleted_at IS NULL
             ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_at,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id
             AND m.sender_id<>?1 AND m.deleted_at IS NULL
             AND (m.created_at>mine.last_read_at OR
                  (m.created_at=mine.last_read_at AND m.id>mine.last_read_id))) AS unread
      FROM conversation_members mine
      JOIN conversations c ON c.id=mine.conversation_id
      JOIN conversation_members other ON other.conversation_id=c.id AND other.user_id<>?1
      JOIN users u ON u.id=other.user_id AND u.deleted_at IS NULL
     WHERE mine.user_id=?1 AND mine.hidden_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM blocks b
         WHERE (b.blocker_id=?1 AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=?1))
     ORDER BY c.updated_at DESC LIMIT 100
  `).bind(me.id).all();
  return json({ conversations: (rows.results || []).map(r => ({ id: r.id,
    person: { id: r.user_id, handle: r.handle, name: r.display_name },
    last_body: r.last_body || "", last_at: r.last_at || r.updated_at, unread: Number(r.unread) || 0 })) });
}

async function listMessages(conversationId, url, env, me) {
  if (!(await conversationMember(env, conversationId, me.id)))
    return json({ error: "見つかりません" }, 404);
  if (!(await socialReadLimit(env, me, "messages")))
    return json({ error: "読み込み回数が多すぎます" }, 429);
  const cursor = socialCursor(url);
  if (!cursor) return json({ error: "カーソルが不正です" }, 400);
  const rows = await env.DB.prepare(`
    SELECT m.id,m.sender_id,m.body,m.created_at,u.handle,u.display_name
      FROM messages m JOIN users u ON u.id=m.sender_id
     WHERE m.conversation_id=?1 AND m.deleted_at IS NULL
       AND (m.created_at<?2 OR (m.created_at=?2 AND m.id<?3))
       AND NOT EXISTS (SELECT 1 FROM blocks b
         WHERE (b.blocker_id=?4 AND b.blocked_id=m.sender_id)
            OR (b.blocker_id=m.sender_id AND b.blocked_id=?4))
     ORDER BY m.created_at DESC,m.id DESC LIMIT 60
  `).bind(conversationId, cursor.time, cursor.id, me.id).all();
  const descending = rows.results || [], oldest = descending[descending.length - 1];
  const messages = descending.slice().reverse().map(r => ({ id: r.id, body: r.body,
    created_at: r.created_at, mine: r.sender_id === me.id,
    sender: { id: r.sender_id, handle: r.handle, name: r.display_name } }));
  const newest = messages[messages.length - 1];
  return json({ messages,
    cursor: oldest ? `${oldest.created_at}:${oldest.id}` : cursor.raw,
    latest_message_id: newest ? newest.id : null,
    has_more: descending.length === 60 });
}

async function createMessage(conversationId, request, env, me) {
  const parsed = await limitedJson(request, 8_000);
  if (parsed.error) return parsed.error;
  const body = limitedText(parsed.value.body, 2000);
  if (!body) return json({ error: "メッセージを入力してください" }, 400);
  const operationId = parsed.value.client_operation_id == null ? null : String(parsed.value.client_operation_id);
  if (!operationId || !/^[A-Za-z0-9_-]{8,80}$/.test(operationId))
    return json({ error: "操作IDが不正です" }, 400);
  if (!(await conversationMember(env, conversationId, me.id)))
    return json({ error: "見つかりません" }, 404);
  const replay = await env.DB.prepare(`
    SELECT id,body,created_at FROM messages
     WHERE conversation_id=? AND sender_id=? AND client_operation_id=?
  `).bind(conversationId, me.id, operationId).first();
  if (replay) return replay.body === body
    ? json({ ...replay, mine: true, replayed: true })
    : json({ error: "同じ操作IDの内容が一致しません" }, 409);
  if (!(await socialWriteLimit(env, me, "messages")) ||
      !(await userLimit(env, me.id, "messages-day", dayKey(), 600)))
    return json({ error: "送信回数が多すぎます" }, 429);
  const other = await env.DB.prepare(`
    SELECT u.id,u.handle,u.display_name FROM conversation_members cm
      JOIN users u ON u.id=cm.user_id
     WHERE cm.conversation_id=? AND cm.user_id<>? AND u.deleted_at IS NULL LIMIT 1
  `).bind(conversationId, me.id).first();
  if (!other || await isBlocked(env, me.id, other.id) || !(await areFriends(env, me.id, other.id)))
    return json({ error: "現在この相手には送信できません" }, 403);
  const id = uuid(), now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO messages (id,conversation_id,sender_id,body,client_operation_id,created_at) VALUES (?,?,?,?,?,?)")
        .bind(id, conversationId, me.id, body, operationId, now),
      env.DB.prepare("UPDATE conversations SET updated_at=? WHERE id=?").bind(now, conversationId),
      env.DB.prepare(`UPDATE conversation_members SET last_read_at=?,last_read_id=?
        WHERE conversation_id=? AND user_id=?`).bind(now, id, conversationId, me.id)
    ]);
  } catch (error) {
    const existing = await env.DB.prepare(`SELECT id,body,created_at FROM messages
      WHERE conversation_id=? AND sender_id=? AND client_operation_id=?`)
      .bind(conversationId, me.id, operationId).first();
    if (existing) return existing.body === body
      ? json({ ...existing, mine: true, replayed: true })
      : json({ error: "同じ操作IDの内容が一致しません" }, 409);
    throw error;
  }
  const fresh = await putNotification(env, other.id, me.id, "message", "conversation",
    conversationId, `message:${id}`);
  if (fresh) await sendPush(env, other.id, me.display_name || me.handle || "フレンド",
    "新しいメッセージが届きました", { conversation: conversationId });
  return json({ id, body, created_at: now, mine: true }, 201);
}

async function readConversation(conversationId, request, env, me) {
  const member = await conversationMember(env, conversationId, me.id);
  if (!member) return json({ error: "見つかりません" }, 404);
  if (!(await socialWriteLimit(env, me, "message-read")))
    return json({ error: "操作回数が多すぎます" }, 429);
  const parsed = await limitedJson(request, 2_000);
  if (parsed.error) return parsed.error;
  const messageId = String(parsed.value.last_message_id || "");
  if (messageId && !/^[A-Za-z0-9_-]{8,80}$/.test(messageId))
    return json({ error: "メッセージIDが不正です" }, 400);
  let last = null;
  if (messageId) {
    last = await env.DB.prepare(`SELECT id,created_at FROM messages
      WHERE id=? AND conversation_id=? AND deleted_at IS NULL`).bind(messageId, conversationId).first();
    if (!last) return json({ error: "見つかりません" }, 404);
  }
  const now = Date.now();
  const statements = [];
  if (last) statements.push(env.DB.prepare(`UPDATE conversation_members
    SET last_read_at=?,last_read_id=? WHERE conversation_id=? AND user_id=?
      AND (last_read_at<? OR (last_read_at=? AND last_read_id<?))`)
    .bind(last.created_at, last.id, conversationId, me.id, last.created_at, last.created_at, last.id));
  statements.push(
    env.DB.prepare("UPDATE notifications SET read_at=? WHERE user_id=? AND entity_type='conversation' AND entity_id=? AND read_at IS NULL")
      .bind(now, me.id, conversationId)
  );
  await env.DB.batch(statements);
  return json({ ok: true });
}

async function ownAlbum(env, me, albumId) {
  return await env.DB.prepare(
    "SELECT * FROM social_albums WHERE id=? AND user_id=? AND deleted_at IS NULL"
  ).bind(albumId, me.id).first();
}

async function viewableAlbum(env, me, albumId) {
  const album = await env.DB.prepare("SELECT * FROM social_albums WHERE id=? AND deleted_at IS NULL")
    .bind(albumId).first();
  if (!album || await isBlocked(env, me.id, album.user_id)) return null;
  if (album.user_id === me.id || album.visibility === "public") return album;
  if (album.visibility === "friends" && await areFriends(env, me.id, album.user_id)) return album;
  return null;
}

async function listAlbums(url, env, me) {
  if (!(await socialReadLimit(env, me, "albums")))
    return json({ error: "読み込み回数が多すぎます" }, 429);
  const handle = String(url.searchParams.get("user") || me.handle || "");
  const owner = await env.DB.prepare("SELECT id,handle,display_name FROM users WHERE handle=? AND deleted_at IS NULL")
    .bind(handle).first();
  if (!owner || await isBlocked(env, me.id, owner.id)) return json({ error: "見つかりません" }, 404);
  const friend = owner.id !== me.id && await areFriends(env, me.id, owner.id);
  const rows = await env.DB.prepare(`
    SELECT a.id,a.title,a.description,a.visibility,a.updated_at,
           COUNT(i.post_id) AS item_count
      FROM social_albums a LEFT JOIN social_album_items i ON i.album_id=a.id
     WHERE a.user_id=?1 AND a.deleted_at IS NULL
       AND (?2=1 OR a.visibility='public' OR (?3=1 AND a.visibility='friends'))
     GROUP BY a.id ORDER BY a.updated_at DESC LIMIT 100
  `).bind(owner.id, owner.id === me.id ? 1 : 0, friend ? 1 : 0).all();
  return json({ owner, albums: (rows.results || []).map(r => ({ ...r, item_count: Number(r.item_count) || 0 })) });
}

async function createAlbum(request, env, me) {
  const parsed = await limitedJson(request, 24_000);
  if (parsed.error) return parsed.error;
  if (!(await socialWriteLimit(env, me, "albums")) ||
      !(await userLimit(env, me.id, "albums-day", dayKey(), 30)))
    return json({ error: "アルバム作成数が多すぎます" }, 429);
  const title = limitedText(parsed.value.title, 100);
  const description = limitedText(parsed.value.description, 1000);
  const visibility = ["private", "friends", "public"].includes(parsed.value.visibility)
    ? parsed.value.visibility : "private";
  if (!title || description === null) return json({ error: "アルバム名を確認してください" }, 400);
  const id = uuid(), now = Date.now();
  await env.DB.prepare(`
    INSERT INTO social_albums (id,user_id,title,description,visibility,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)
  `).bind(id, me.id, title, description || "", visibility, now, now).run();
  return json({ id, title, description: description || "", visibility }, 201);
}

async function getAlbum(albumId, env, me) {
  if (!(await socialReadLimit(env, me, "albums")))
    return json({ error: "読み込み回数が多すぎます" }, 429);
  const album = await viewableAlbum(env, me, albumId);
  if (!album) return json({ error: "見つかりません" }, 404);
  const rows = await env.DB.prepare(`
    SELECT p.id,p.title,p.tag,p.place_name,p.taken_at,p.visibility,
           (SELECT ph.id FROM photos ph WHERE ph.post_id=p.id
             AND (p.user_id=?2 OR ph.moderation_state='ok')
             ORDER BY ph.sort_order,ph.created_at LIMIT 1) AS photo_id
      FROM social_album_items i JOIN posts p ON p.id=i.post_id
     WHERE i.album_id=?1 AND p.deleted_at IS NULL
       AND (p.user_id=?2 OR (p.publish_at<=?3 AND
         (p.visibility='public' OR (p.visibility='friends' AND ?4=1))))
     ORDER BY i.sort_order,i.created_at
  `).bind(albumId, me.id, Date.now(), await areFriends(env, me.id, album.user_id) ? 1 : 0).all();
  return json({ album, posts: rows.results || [] });
}

async function patchAlbum(albumId, request, env, me) {
  if (!(await socialWriteLimit(env, me, "albums")))
    return json({ error: "操作回数が多すぎます" }, 429);
  const album = await ownAlbum(env, me, albumId);
  if (!album) return json({ error: "見つかりません" }, 404);
  const parsed = await limitedJson(request, 8_000);
  if (parsed.error) return parsed.error;
  const sets = [], values = [];
  if ("title" in parsed.value) {
    const title = limitedText(parsed.value.title, 100); if (!title) return json({ error: "アルバム名を確認してください" }, 400);
    sets.push("title=?"); values.push(title);
  }
  if ("description" in parsed.value) {
    const description = limitedText(parsed.value.description, 1000); if (description === null) return json({ error: "説明が長すぎます" }, 413);
    sets.push("description=?"); values.push(description);
  }
  if ("visibility" in parsed.value) {
    if (!["private", "friends", "public"].includes(parsed.value.visibility)) return json({ error: "公開範囲が不正です" }, 400);
    sets.push("visibility=?"); values.push(parsed.value.visibility);
  }
  if (!sets.length) return json({ ok: true });
  sets.push("updated_at=?"); values.push(Date.now(), albumId, me.id);
  await env.DB.prepare(`UPDATE social_albums SET ${sets.join(",")} WHERE id=? AND user_id=?`)
    .bind(...values).run();
  return json({ ok: true });
}

async function deleteAlbum(albumId, env, me) {
  if (!(await socialWriteLimit(env, me, "albums")))
    return json({ error: "操作回数が多すぎます" }, 429);
  const result = await env.DB.prepare(
    "UPDATE social_albums SET deleted_at=?,updated_at=? WHERE id=? AND user_id=? AND deleted_at IS NULL"
  ).bind(Date.now(), Date.now(), albumId, me.id).run();
  if (!result.meta || result.meta.changes !== 1) return json({ error: "見つかりません" }, 404);
  return json({ ok: true });
}

async function replaceAlbumItems(albumId, request, env, me) {
  if (!(await socialWriteLimit(env, me, "album-items")))
    return json({ error: "操作回数が多すぎます" }, 429);
  const album = await ownAlbum(env, me, albumId);
  if (!album) return json({ error: "見つかりません" }, 404);
  const parsed = await limitedJson(request, 24_000);
  if (parsed.error) return parsed.error;
  const ids = Array.isArray(parsed.value.post_ids) ? Array.from(new Set(parsed.value.post_ids.map(String)
    .filter(id => /^[A-Za-z0-9_-]{8,80}$/.test(id)))).slice(0, 200) : [];
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    const owned = await env.DB.prepare(`SELECT id,visibility FROM posts WHERE user_id=? AND deleted_at IS NULL AND id IN (${marks})`)
      .bind(me.id, ...ids).all();
    if ((owned.results || []).length !== ids.length) return json({ error: "自分の投稿だけを追加できます" }, 403);
    const validVisibility = (owned.results || []).every(p => album.visibility === "private" ||
      (album.visibility === "friends" ? p.visibility !== "private" : p.visibility === "public"));
    if (!validVisibility) return json({ error: "アルバムより狭い公開範囲の投稿が含まれています" }, 409);
  }
  const now = Date.now(), statements = [
    env.DB.prepare("DELETE FROM social_album_items WHERE album_id=?").bind(albumId)
  ];
  ids.forEach((id, index) => statements.push(env.DB.prepare(
    "INSERT INTO social_album_items (album_id,post_id,sort_order,created_at) VALUES (?,?,?,?)"
  ).bind(albumId, id, index, now)));
  statements.push(env.DB.prepare("UPDATE social_albums SET updated_at=? WHERE id=? AND user_id=?")
    .bind(now, albumId, me.id));
  await env.DB.batch(statements);
  return json({ ok: true, count: ids.length });
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hashToken(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function createShareLink(request, env, me) {
  const parsed = await limitedJson(request, 4_000);
  if (parsed.error) return parsed.error;
  if (!(await socialWriteLimit(env, me, "shares")))
    return json({ error: "共有リンクの作成回数が多すぎます" }, 429);
  const type = parsed.value.target_type, id = String(parsed.value.target_id || "");
  if (!["post", "album"].includes(type) || !/^[A-Za-z0-9_-]{8,80}$/.test(id))
    return json({ error: "共有対象が不正です" }, 400);
  if (type === "post") {
    const post = await viewablePost(env, me, id);
    if (!post) return json({ error: "見つかりません" }, 404);
    if (post.user_id !== me.id) return json({ error: "自分の投稿だけ共有できます" }, 403);
    if (post.visibility !== "public") return json({ error: "共有リンクは公開投稿だけ作れます" }, 409);
  } else {
    const album = await ownAlbum(env, me, id);
    if (!album) return json({ error: "見つかりません" }, 404);
    if (album.visibility !== "public") return json({ error: "共有リンクは公開アルバムだけ作れます" }, 409);
  }
  const days = Math.max(1, Math.min(30, Number(parsed.value.expires_in_days || 7) | 0));
  const token = randomToken(), hash = await hashToken(token), now = Date.now();
  await env.DB.prepare(`
    INSERT INTO share_links (token_hash,owner_id,target_type,target_id,created_at,expires_at)
    VALUES (?,?,?,?,?,?)
  `).bind(hash, me.id, type, id, now, now + days * 86400000).run();
  return json({ token, path: "/api/share/" + token, expires_at: now + days * 86400000 }, 201);
}

async function revokeShareLink(token, env, me) {
  if (!(await socialWriteLimit(env, me, "shares")))
    return json({ error: "操作回数が多すぎます" }, 429);
  const hash = await hashToken(token);
  const result = await env.DB.prepare(
    "UPDATE share_links SET revoked_at=? WHERE token_hash=? AND owner_id=? AND revoked_at IS NULL"
  ).bind(Date.now(), hash, me.id).run();
  if (!result.meta || result.meta.changes !== 1) return json({ error: "見つかりません" }, 404);
  return json({ ok: true });
}

async function resolveShareLink(token, request, env) {
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(token)) return json({ error: "見つかりません" }, 404);
  const client = await clientRateId(request);
  if (!(await publicShareAllowance(env, client, token, "meta")))
    return json({ error: "読み込み回数が多すぎます" }, 429);
  const hash = await hashToken(token), now = Date.now();
  const link = await env.DB.prepare(`
    SELECT target_type,target_id FROM share_links
     WHERE token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)
  `).bind(hash, now).first();
  if (!link) return json({ error: "リンクは無効です" }, 404);
  if (link.target_type === "post") {
    const post = await env.DB.prepare(`
      SELECT p.id,p.title,p.tag,p.place_name,p.taken_at,u.handle,u.display_name,
             (SELECT ph.id FROM photos ph WHERE ph.post_id=p.id
               AND ph.moderation_state='ok' AND ph.key_view IS NOT NULL
               ORDER BY ph.sort_order,ph.created_at LIMIT 1) AS photo_id
        FROM posts p JOIN users u ON u.id=p.user_id
       WHERE p.id=? AND p.deleted_at IS NULL AND p.visibility='public' AND p.publish_at<=?
    `).bind(link.target_id, now).first();
    if (post) {
      post.title=publicLocationLabel(post.title);post.place_name=publicLocationLabel(post.place_name);
      if (post.photo_id) post.photo_path=`/api/share/${token}/photo/${post.photo_id}/view`;
    }
    return post ? json({ type: "post", post }) : json({ error: "公開が終了しました" }, 404);
  }
  const album = await env.DB.prepare(`
    SELECT id,title,description,user_id FROM social_albums
     WHERE id=? AND deleted_at IS NULL AND visibility='public'
  `).bind(link.target_id).first();
  if (!album) return json({ error: "公開が終了しました" }, 404);
  const posts = await env.DB.prepare(`
    SELECT p.id,p.title,p.tag,p.place_name,p.taken_at,
           (SELECT ph.id FROM photos ph WHERE ph.post_id=p.id
             AND ph.moderation_state='ok' AND ph.key_view IS NOT NULL
             ORDER BY ph.sort_order,ph.created_at LIMIT 1) AS photo_id
      FROM social_album_items i JOIN posts p ON p.id=i.post_id
     WHERE i.album_id=? AND p.deleted_at IS NULL AND p.visibility='public' AND p.publish_at<=?
     ORDER BY i.sort_order,i.created_at
  `).bind(album.id, now).all();
  const safePosts=(posts.results||[]).map(post => ({...post,
    title:publicLocationLabel(post.title),place_name:publicLocationLabel(post.place_name),
    photo_path:post.photo_id?`/api/share/${token}/photo/${post.photo_id}/view`:null}));
  return json({ type: "album", album, posts: safePosts });
}

async function getSharedPhoto(token, photoId, kind, request, env) {
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(token)) return json({ error: "見つかりません" }, 404);
  const client = await clientRateId(request);
  if (!(await publicShareAllowance(env, client, token, "photo")))
    return json({ error: "読み込み回数が多すぎます" }, 429);
  const hash = await hashToken(token), now = Date.now();
  const link = await env.DB.prepare(`
    SELECT target_type,target_id FROM share_links
     WHERE token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)
  `).bind(hash, now).first();
  if (!link) return json({ error: "リンクは無効です" }, 404);
  const photo = await env.DB.prepare(`
    SELECT ph.post_id,ph.key_view,ph.key_thumb,ph.moderation_state,p.visibility,p.publish_at,p.deleted_at
      FROM photos ph JOIN posts p ON p.id=ph.post_id WHERE ph.id=?
  `).bind(photoId).first();
  if (!photo || photo.deleted_at || photo.visibility !== "public" || photo.publish_at > now ||
      photo.moderation_state !== "ok") return json({ error: "見つかりません" }, 404);
  const allowed = link.target_type === "post" ? photo.post_id === link.target_id
    : !!(await env.DB.prepare(`SELECT 1 FROM social_album_items i
        JOIN social_albums a ON a.id=i.album_id
       WHERE i.album_id=? AND i.post_id=? AND a.deleted_at IS NULL AND a.visibility='public'`)
      .bind(link.target_id, photo.post_id).first());
  if (!allowed) return json({ error: "見つかりません" }, 404);
  const key = kind === "thumb" ? photo.key_thumb : photo.key_view;
  if (!key) return json({ error: "見つかりません" }, 404);
  const object = await env.PHOTOS.get(key);
  if (!object) return json({ error: "見つかりません" }, 404);
  return new Response(object.body,{headers:{
    "Content-Type":object.httpMetadata?.contentType||"image/jpeg",
    // トークン失効・アルバム非公開化を端末キャッシュで迂回させない。
    "Cache-Control":"private, no-store"
  }});
}


/* ============================================================
   小道具
   ============================================================ */

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** 外部ログへURL・高精度座標・長い応答本文を残さない。 */
function safeLogError(error) {
  return String(error && error.message || error || "error")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/-?\d{1,3}\.\d{4,}/g, "[number]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
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

/** Content-Lengthが無いチャンク転送でも、上限を越えてメモリへ溜めない。 */
async function readBodyLimited(request, maxBytes) {
  if (!request.body || typeof request.body.getReader !== "function") {
    const bytes = await request.arrayBuffer();
    return bytes.byteLength <= maxBytes ? bytes : null;
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const value = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value || 0);
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch (_) { /* 読み取り停止を優先 */ }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) { /* 既に解放済み */ }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out.buffer;
}

/** Content-Length が無い場合も、実際に読んだUTF-8バイト数で制限する。 */
async function limitedJson(request, maxBytes) {
  const declaredHeader = request.headers.get("Content-Length");
  const declared = declaredHeader == null ? null : Number(declaredHeader);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0))
    return { error: json({ error: "入力サイズが不正です" }, 400) };
  if (declared !== null && declared > maxBytes)
    return { error: json({ error: "入力が大きすぎます" }, 413) };
  const bytes = await readBodyLimited(request, maxBytes);
  if (bytes === null) return { error: json({ error: "入力が大きすぎます" }, 413) };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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

/**
 * 短時間の連打だけを止める制限はD1へ書かない。
 * Rate Limiting bindingが使えないローカル検証では機能を止めず、
 * 日次上限や有料APIの厳密な上限は引き続きuserLimitで守る。
 */
async function burstLimit(env, bindingName, key) {
  const binding = env[bindingName];
  if (!binding || typeof binding.limit !== "function") return true;
  try {
    const result = await binding.limit({ key: String(key || "unknown") });
    return !!(result && result.success);
  } catch (error) {
    console.error("rate limiter error", bindingName, safeLogError(error));
    return false;
  }
}

function socialReadLimit(env, me, scope) {
  return burstLimit(env, "SOCIAL_READ_RATE_LIMITER", `${me.id}:${scope}`);
}

function socialWriteLimit(env, me, scope) {
  return burstLimit(env, "SOCIAL_WRITE_RATE_LIMITER", `${me.id}:${scope}`);
}

/** tokenを変えてIP制限を回避できないよう、client全体→token単位の順で制限する。 */
async function publicShareAllowance(env, client, token, scope) {
  if (!(await burstLimit(env, "SHARE_RATE_LIMITER", `${client}:all`))) return false;
  if (!(await atomicLimit(env, "share_public_day_" + dayKey(), 100_000, 1))) return false;
  return burstLimit(env, "SHARE_RATE_LIMITER", `${client}:${token.slice(0, 16)}:${scope}`);
}

/** 日次Cron。期限の切れた一時カウンターだけを削除し、設定値は残す。 */
async function cleanupTransientConfig(env) {
  const today = dayKey();
  const month = monthKey();
  const statements = [
    env.DB.prepare("DELETE FROM app_config WHERE k LIKE 'ul\\_%' ESCAPE '\\' AND k NOT LIKE ? AND k NOT LIKE '%\\_all\\_%' ESCAPE '\\'")
      .bind("%" + today + "%"),
    env.DB.prepare("DELETE FROM app_config WHERE k LIKE 'mod\\_%' ESCAPE '\\' AND k NOT LIKE ?")
      .bind("mod_" + today + "_%"),
    env.DB.prepare("DELETE FROM app_config WHERE k LIKE 'nom\\_%' ESCAPE '\\' AND k NOT LIKE ?")
      .bind("%" + today + "%"),
    env.DB.prepare("DELETE FROM app_config WHERE k LIKE 'postal\\_code\\_day\\_%' ESCAPE '\\' AND k<>?")
      .bind("postal_code_day_" + today),
    env.DB.prepare("DELETE FROM app_config WHERE k LIKE 'q\\_%' ESCAPE '\\' AND k NOT LIKE ?")
      .bind("%_" + month),
    env.DB.prepare("DELETE FROM app_config WHERE k LIKE 'share_public_day_%' AND k<>?")
      .bind("share_public_day_" + today),
    env.DB.prepare("DELETE FROM app_config WHERE k LIKE 'reverse_global_day_%' AND k<>?")
      .bind("reverse_global_day_" + today),
    env.DB.prepare("DELETE FROM app_config WHERE k LIKE 'places_global_day_%' AND k<>?")
      .bind("places_global_day_" + today),
    env.DB.prepare("DELETE FROM app_config WHERE k LIKE 'friend_request_global_day_%' AND k<>?")
      .bind("friend_request_global_day_" + today),
    env.DB.prepare("DELETE FROM app_config WHERE k LIKE 'friend_accept_global_day_%' AND k<>?")
      .bind("friend_accept_global_day_" + today),
    env.DB.prepare("DELETE FROM app_config WHERE k LIKE 'likes_global_day_%' AND k<>?")
      .bind("likes_global_day_" + today)
  ];
  for (const statement of statements) await statement.run();
}

/** 削除後30日を過ぎた写真を、現役投稿から参照されていない場合だけR2から回収する。 */
async function cleanupDeletedPhotos(env) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const rows = await env.DB.prepare(`
    SELECT ph.id,ph.key_orig,ph.key_view,ph.key_thumb
      FROM photos ph JOIN posts p ON p.id=ph.post_id
     WHERE p.deleted_at IS NOT NULL AND p.deleted_at<?
     LIMIT 8
  `).bind(cutoff).all();
  for (const ph of (rows.results || [])) {
    const keys = [ph.key_orig, ph.key_view, ph.key_thumb].filter(Boolean);
    for (const key of keys) {
      const used = await env.DB.prepare(`
        SELECT 1 FROM photos x JOIN posts p ON p.id=x.post_id
         WHERE p.deleted_at IS NULL
           AND (x.key_orig=?1 OR x.key_view=?1 OR x.key_thumb=?1)
         LIMIT 1
      `).bind(key).first();
      if (!used) await env.PHOTOS.delete(key);
    }
    await env.DB.prepare("DELETE FROM photos WHERE id=?").bind(ph.id).run();
  }
}

async function shortHash(value) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(buf).slice(0, 12))
    .map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

/** 公開してよい少量データだけを短時間キャッシュする。認証済みレスポンスには使わない。 */
function publicJson(obj) {
  const res = json(obj);
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=60");
  return new Response(res.body, { status: res.status, headers });
}

function cors(res, request) {
  const h = new Headers(res.headers);
  const origin = request.headers.get("Origin");
  const selfOrigin = new URL(request.url).origin;
  const allowed = !origin || origin === selfOrigin || origin === "capacitor://localhost" ||
    origin === "http://localhost";
  if (origin && allowed) h.set("Access-Control-Allow-Origin", origin);
  else h.delete("Access-Control-Allow-Origin");
  h.append("Vary", "Origin");
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

/**
 * 郵便番号から住所を引く。端末から第三者APIへ直接接続させず、Workerで入力検証、
 * キャッシュ、利用制限を行う。上流は日本郵便の公開データを毎日JSON化するMIT実装。
 */
async function postalCodeLookup(request, env, me) {
  const parsed = await limitedJson(request, 256);
  if (parsed.error) return parsed.error;
  const raw = String(parsed.value.postalCode || "").trim();
  if (!/^\d{3}-?\d{4}$/.test(raw)) {
    return json({ error: "郵便番号は7桁で入力してください" }, 400);
  }
  const postalCode = raw.replace("-", "");

  // キャッシュ命中時も制限する。大量の同一検索によるWorker呼び出しDoSを抑える。
  const rateId = await shortHash(me.id);
  const userBurst = await env.POSTAL_USER_RATE_LIMITER.limit({ key: rateId });
  const globalBurst = await env.POSTAL_GLOBAL_RATE_LIMITER.limit({ key: "postal-code" });
  if (!userBurst.success || !globalBurst.success ||
      !(await userLimit(env, rateId, "postal-code-hour", hourKey(), 120)) ||
      !(await userLimit(env, rateId, "postal-code-day", dayKey(), 500))) {
    return json({ error: "郵便番号検索が混み合っています" }, 429);
  }
  if (!(await atomicLimit(env, "postal_code_day_" + dayKey(), 50_000, 1))) {
    return json({ error: "郵便番号検索が混み合っています" }, 429);
  }

  const cache = caches.default;
  const cacheRequest = new Request("https://spota-cache.invalid/postal-code/" + postalCode);
  const hit = await cache.match(cacheRequest);
  if (hit) return hit;

  const upstream = await fetch(POSTAL_CODE_API + postalCode + ".json", {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(5_000)
  });
  if (upstream.status === 404) return json({ error: "該当する郵便番号がありません" }, 404);
  if (!upstream.ok) return json({ error: "郵便番号検索を利用できません" }, 502);

  const contentLength = Number(upstream.headers.get("Content-Length") || 0);
  if (contentLength > 100_000) return json({ error: "郵便番号検索を利用できません" }, 502);
  const body = await upstream.text();
  if (new TextEncoder().encode(body).byteLength > 100_000) {
    return json({ error: "郵便番号検索を利用できません" }, 502);
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return json({ error: "郵便番号検索を利用できません" }, 502);
  }
  const addresses = (Array.isArray(data && data.addresses) ? data.addresses : []).slice(0, 20).map(function (row) {
    function language(value) {
      value = value && typeof value === "object" ? value : {};
      function addressText(text, max) {
        // JSONを将来誤ってHTMLへ挿入してもタグとして成立しにくい形へ正規化する。
        return (limitedText(text, max) || "").replace(/[<>]/g, "");
      }
      return {
        prefecture: addressText(value.prefecture, 80),
        address1: addressText(value.address1, 160),
        address2: addressText(value.address2, 160),
        address3: addressText(value.address3, 160),
        address4: addressText(value.address4, 160)
      };
    }
    return {
      prefectureCode: /^\d{2}$/.test(String(row && row.prefectureCode || "")) ? String(row.prefectureCode) : "",
      ja: language(row && row.ja),
      kana: language(row && row.kana),
      en: language(row && row.en)
    };
  });
  if (!addresses.length) return json({ error: "該当する郵便番号がありません" }, 404);

  const response = json({
    postalCode,
    addresses,
    source: "日本郵便の郵便番号データを加工した jp-postal-code-api"
  });
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=86400");
  const cached = new Response(response.body, { status: response.status, headers });
  await cache.put(cacheRequest, cached.clone());
  return cached;
}

async function geocode(request, env) {
  if (request.method !== "POST") return json({ error: "POSTだけです" }, 405);
  const parsed = await limitedJson(request, 4_000);
  if (parsed.error) return parsed.error;
  const q = String(parsed.value.q || "").trim();
  if (!q || q.length > 120 || /[\u0000-\u001f]/.test(q)) {
    return json({ error: "検索語が不正です" }, 400);
  }
  const limit = Math.min(4, Math.max(1, Number.parseInt(parsed.value.limit || "4", 10) || 4));
  const client = await clientRateId(request);
  // cache hitでもWorker invocationは発生するため、cache照会より先にclient単位で止める。
  if (!(await burstLimit(env, "GEOCODE_RATE_LIMITER", client))) {
    return json({ error: "地名検索が混み合っています" }, 429);
  }
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
    const r = await fetch(up, { headers: { "User-Agent": NOMINATIM_UA, "Accept": "application/json" },
      signal: AbortSignal.timeout(8_000) });
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

// 回帰テスト用。HTTP経路は上のdefault exportだけが公開する。
// 実運用と同じSQL経路をローカル統合テストから直接検証する。
export { friendRequest, geocode, putLike, deleteLike, listComments, createComment, flashPost,
  createReport, createMonitorArtifacts, cleanupCommunicationMonitors, processAccountDeletion,
  fcmRelayConfigured, relaySignature, isLegacyApnsToken, wikipediaApiEnabled,
  isMapTrendEditor, normalizeMapTrendTerms, publicMapTrends, getMapTrendEditorTerms,
  replaceMapTrendTerms };

async function reverseGeocode(request, env) {
  if (request.method !== "POST") return json({ error: "POSTだけです" }, 405);
  const parsed = await limitedJson(request, 4_000);
  if (parsed.error) return parsed.error;
  let lat = Number(parsed.value.lat);
  let lng = Number(parsed.value.lng);
  if (!validCoords(lat, lng)) return json({ error: "位置が不正です" }, 400);
  const client = await clientRateId(request);
  if (!(await userLimit(env, client, "reverse-hour", hourKey(), 300)) ||
      !(await userLimit(env, client, "reverse-day", dayKey(), 3000)) ||
      !(await atomicLimit(env, "reverse_global_day_" + dayKey(), 200_000, 1))) {
    return json({ error: "住所検索が混み合っています" }, 429);
  }
  // 約11m単位へ丸め、端末由来の過剰に細かい座標を第三者へ渡さない。
  lat = Math.round(lat * 10_000) / 10_000;
  lng = Math.round(lng * 10_000) / 10_000;
  // 国交省・デジタル庁由来のD1だけで判定し、EXIF位置を第三者へ送らない。
  const local = await reverseFromAddressDb(lat, lng, env);
  if (local) return json(local);
  return json({ name: "撮影場所", display_name: "", address: {}, source: "local-none" });
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
        console.error("address db error", safeLogError(error));
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
        console.error("admin boundary decode error", safeLogError(error));
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
   自前の場所マスタ

   外から取ってきたものは、そのつど places に貯める。
   同じところを二度取りに行かなくて済むし、
   外のサービスが止まっても地図が空にならない。
   ============================================================ */

/** この範囲にある、貯めてある場所を返す */
async function nearbyPlaces(request, env) {
  const parsed = await limitedJson(request, 512);
  if (parsed.error) return parsed.error;
  const body = parsed.value;
  const s = Number(body.s);
  const w = Number(body.w);
  const n = Number(body.n);
  const e = Number(body.e);
  if (![s, w, n, e].every(isFinite)) return json({ error: "範囲の指定が不正です" }, 400);
  if (s < -90 || n > 90 || w < -180 || e > 180 || s > n || w > e || n - s > 3 || e - w > 3) {
    return json({ error: "範囲の指定が大きすぎます" }, 400);
  }
  const client = await clientRateId(request);
  if (!(await userLimit(env, client, "places-hour", hourKey(), 600)) ||
      !(await userLimit(env, client, "places-day", dayKey(), 5000)) ||
      !(await atomicLimit(env, "places_global_day_" + dayKey(), 200_000, 1))) {
    return json({ error: "読み込み回数が多すぎます" }, 429);
  }

  const requested = Number(body.limit || 300);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(400, Math.trunc(requested))) : 300;

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

/* ============================================================
   使いすぎを止める仕組み

   Google Cloud の予算アラートは「知らせる」だけで、止めてはくれない。
   そこで、こちら側で回数を数えて上限で打ち切る。
   金額ではなく回数で管理すれば、構造的に超えない。

   月あたりの上限（無料枠に収まる数）
     Vision 判定  … 900 枚（無料枠 1,000 の手前）
   ============================================================ */
const LIMITS = { vision: 900 };

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
   回数の上限つき。安全確認は判定不能時も必ず非公開側へ倒す。
   ============================================================ */

const VISION = "https://vision.googleapis.com/v1/images:annotate";

async function callVision(key, img) {

  const res = await fetch(VISION, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
    body: JSON.stringify({
      requests: [{
        image: { content: img },
        features: [
          { type: "SAFE_SEARCH_DETECTION" },
          { type: "LABEL_DETECTION", maxResults: 6 }
        ]
      }]
    }),
    signal: AbortSignal.timeout(10_000)
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
  const key = env.GOOGLE_API_KEY;
  if (!key ||
      !(await userLimit(env, me.id, "vision-hour", hourKey(), 30)) ||
      !(await userLimit(env, me.id, "vision-day", dayKey(), 120)) ||
      !(await useQuota(env, "vision"))) return "error";
  const result = await callVision(key, img);
  await putModerationCache(env, me.id, img, result);
  return result.state;
}

/**
 * Visionの一時障害でerrorになった写真を、最大6回だけ再確認する。
 * error中の画像はgetPhotoが所有者以外へ返さないため、再試行中もfail closed。
 */
async function retryErroredPhotoModeration(env) {
  const rows = await env.DB.prepare(`
    SELECT ph.id,ph.post_id,ph.user_id,ph.key_view,ph.key_thumb,
           ph.moderation_view_state,ph.moderation_thumb_state
      FROM photos ph JOIN posts p ON p.id=ph.post_id
     WHERE ph.moderation_state='error' AND p.deleted_at IS NULL
       AND p.visibility<>'private'
     ORDER BY ph.created_at LIMIT 5
  `).all();
  for (const ph of (rows.results || [])) {
    const retryKey = "photo_moderation_retry_" + ph.id;
    if (!(await atomicLimit(env, retryKey, 6, 1))) continue;
    try {
      const states = {
        view: ph.moderation_view_state,
        thumb: ph.moderation_thumb_state
      };
      for (const variant of ["view", "thumb"]) {
        if (states[variant] === "ok" || states[variant] === "bad") continue;
        const key = ph[`key_${variant}`];
        const object = key ? await env.PHOTOS.get(key) : null;
        if (!object) { states[variant] = "error"; continue; }
        const bytes = await object.arrayBuffer();
        if (!bytes.byteLength || bytes.byteLength > 10_000_000) {
          states[variant] = "error"; continue;
        }
        states[variant] = await moderateUploadedPhoto(env, { id: ph.user_id }, bytes);
      }
      const overall = states.view === "ok" && states.thumb === "ok" ? "ok" :
        (states.view === "bad" || states.thumb === "bad" ? "bad" : "error");
      await env.DB.prepare(`UPDATE photos
        SET moderation_view_state=?,moderation_thumb_state=?,moderation_state=?
        WHERE id=? AND user_id=? AND post_id=?`
      ).bind(states.view, states.thumb, overall, ph.id, ph.user_id, ph.post_id).run();
      if (overall === "bad") {
        await env.DB.prepare("UPDATE posts SET visibility='private' WHERE id=? AND user_id=?")
          .bind(ph.post_id, ph.user_id).run();
        await env.DB.prepare("DELETE FROM app_config WHERE k=?").bind(retryKey).run();
      } else if (overall === "ok") {
        await env.DB.prepare("DELETE FROM app_config WHERE k=?").bind(retryKey).run();
        await announcePostIfReady(env, ph.post_id);
      }
    } catch (error) {
      console.error("photo moderation retry error", safeLogError(error));
    }
  }
}

async function ensurePostPhotosModerated(env, me, postId) {
  const rows = await env.DB.prepare(
    "SELECT id,key_view,key_thumb,moderation_view_state,moderation_thumb_state FROM photos WHERE post_id=? AND user_id=?"
  ).bind(postId, me.id).all();
  return moderatePhotoRows(env, me, rows.results || []);
}

async function moderatePhotoRows(env, me, rows) {
  if (!rows.length) return true;
  for (const ph of rows) {
    // viewとthumbは別オブジェクトなので、どちらもサーバー側で確認する。
    // 一方だけ安全な画像へ差し替えて行全体をokにする迂回を許さない。
    if (!ph.key_view || !ph.key_thumb) return false;
    const states = {};
    for (const variant of ["view", "thumb"]) {
      const key = ph[`key_${variant}`];
      const obj = await env.PHOTOS.get(key);
      if (!obj) return false;
      const bytes = await obj.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 10_000_000) return false;
      states[variant] = await moderateUploadedPhoto(env, me, bytes);
    }
    const overall = states.view === "ok" && states.thumb === "ok" ? "ok" :
      (states.view === "bad" || states.thumb === "bad" ? "bad" : "error");
    if (ph.id) await env.DB.prepare(`UPDATE photos
      SET moderation_view_state=?,moderation_thumb_state=?,moderation_state=?
      WHERE id=? AND user_id=?`).bind(states.view, states.thumb, overall, ph.id, me.id).run();
    if (overall !== "ok") return false;
  }
  return true;
}

/** iOSのAPNs device tokenはFCM HTTP v1のmessage.tokenには使用できない。 */
function isLegacyApnsToken(token, platform) {
  return platform === "ios" && /^[0-9a-f]{64}$/i.test(String(token || ""));
}

async function pushTokensForUser(env, userId) {
  const rows = await env.DB.prepare(
    "SELECT token,platform FROM push_tokens WHERE user_id=? ORDER BY updated_at DESC LIMIT 8"
  ).bind(userId).all();
  const valid = [], legacy = [];
  for (const row of rows.results || []) {
    const token = String(row.token || "");
    if (isLegacyApnsToken(token, row.platform)) legacy.push(token);
    else if (token && token.length <= 4096 && !/\s/.test(token)) valid.push(token);
  }
  // 旧iOS版が誤って保存したAPNs形状の行だけを整理する。
  for (const token of legacy)
    await env.DB.prepare("DELETE FROM push_tokens WHERE token=? AND user_id=?")
      .bind(token, userId).run();
  return valid;
}

/** 通知の宛先を預かる */
async function saveToken(request, env, me) {
  const parsed = await limitedJson(request, 8_000);
  if (parsed.error) return parsed.error;
  const b = parsed.value;
  const t = String(b.token || "").trim();
  if (!t || t.length > 4096 || /\s/.test(t)) return json({ error: "宛先が不正です" }, 400);
  const platform = ["ios", "android", "web"].includes(b.platform) ? b.platform : "ios";
  if (isLegacyApnsToken(t, platform))
    return json({ error: "このアプリの通知登録方式を更新してください", code: "wrong_token_type" }, 400);
  if (!(await userLimit(env, me.id, "push-token-hour", hourKey(), 20))) {
    return json({ error: "登録回数が多すぎます" }, 429);
  }
  await env.DB.prepare(`
    INSERT INTO push_tokens (token, user_id, platform, updated_at)
    VALUES (?,?,?,?)
    ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id,
      platform=excluded.platform,updated_at=excluded.updated_at
  `).bind(t, me.id, platform, Date.now()).run();
  // 正しいFCM token登録時に、同じ利用者の旧APNs形状tokenを除去する。
  if (platform === "ios") await env.DB.prepare(`
    DELETE FROM push_tokens
     WHERE user_id=? AND platform='ios' AND token<>? AND length(token)=64
       AND token NOT GLOB '*[^0-9A-Fa-f]*'
  `).bind(me.id, t).run();
  // 1アカウント8端末まで。古い宛先を残してfan-outを増幅させない。
  await env.DB.prepare(`
    DELETE FROM push_tokens WHERE user_id=?1 AND token NOT IN (
      SELECT token FROM push_tokens WHERE user_id=?1 ORDER BY updated_at DESC LIMIT 8
    )
  `).bind(me.id).run();
  return json({ ok: true });
}

async function deleteToken(request, env, me) {
  const parsed = await limitedJson(request, 8_000);
  if (parsed.error) return parsed.error;
  const token = String(parsed.value.token || "").trim();
  if (!token || token.length > 4096 || /\s/.test(token)) return json({ error: "宛先が不正です" }, 400);
  await env.DB.prepare("DELETE FROM push_tokens WHERE token=? AND user_id=?")
    .bind(token, me.id).run();
  return json({ ok: true });
}


/* ============================================================
   通知を送る

   Firebase を通してiPhoneへ届ける。
   送るときに音の名前を指定すると、その音で鳴る。
   （音のファイルはアプリの中に入れておく）
   ============================================================ */

const SOUND = "default";       // XcodeのResources登録漏れに左右されないOS標準音

function fcmRelayConfigured(env) {
  if (typeof env.FCM_RELAY_SHARED_SECRET !== "string" ||
      env.FCM_RELAY_SHARED_SECRET.length < 32) return false;
  try {
    const url = new URL(String(env.FCM_RELAY_URL || ""));
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch (_) {
    return false;
  }
}

function relayBase64Url(bytes) {
  let text = "";
  const values = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < values.length; i += 0x8000)
    text += String.fromCharCode(...values.subarray(i, i + 0x8000));
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function relaySignature(secret, timestamp, nonce, body) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const payload = `${timestamp}.${nonce}.${body}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return relayBase64Url(signature);
}

/** Cloud RunのADCにFCM認証を任せ、WorkerにはGoogle秘密鍵を置かない。 */
async function sendPushViaRelay(env, messages) {
  if (!fcmRelayConfigured(env))
    return { sent: 0, code: "fcm_not_configured", token_count: messages.length, invalid_tokens: [] };
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomToken();
  const body = JSON.stringify({ messages });
  try {
    const signature = await relaySignature(env.FCM_RELAY_SHARED_SECRET, timestamp, nonce, body);
    const response = await fetch(new URL("/send", env.FCM_RELAY_URL), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Spota-Timestamp": timestamp,
        "X-Spota-Nonce": nonce,
        "X-Spota-Signature": signature
      },
      body,
      signal: AbortSignal.timeout(8_000)
    });
    let result = null;
    try { result = await response.json(); } catch (_) {}
    if (!response.ok || !result || !Number.isFinite(Number(result.sent)))
      return { sent: 0, code: response.status === 429 ? "relay_rate_limited" : "relay_error", token_count: messages.length, invalid_tokens: [] };
    return {
      sent: Math.max(0, Math.min(messages.length, Number(result.sent))),
      code: String(result.code || (result.sent ? "accepted" : "rejected")),
      token_count: messages.length,
      invalid_tokens: Array.isArray(result.invalid_tokens) ? result.invalid_tokens.filter(t => typeof t === "string") : []
    };
  } catch (_) {
    return { sent: 0, code: "relay_unreachable", token_count: messages.length, invalid_tokens: [] };
  }
}

/** ある人に通知を届け、FCMが受理した端末数も返す。 */
async function sendPushDetailed(env, userId, title, body, data) {
  if (!(await userLimit(env, userId, "push-recipient-day", dayKey(), 100)) ||
      !(await atomicLimit(env, "push_global_hour_" + hourKey(), 10_000, 1)))
    return { sent: 0, code: "rate_limited", token_count: 0 };
  if (!fcmRelayConfigured(env)) return { sent: 0, code: "fcm_not_configured", token_count: 0 };

  const tokens = await pushTokensForUser(env, userId);
  if (!tokens.length) return { sent: 0, code: "device_not_registered", token_count: 0 };

  const messages = tokens.map(function (t) {
    return { message: {
      token: t,
      notification: { title: String(title || "").slice(0, 120), body: String(body || "").slice(0, 1000) },
      data: Object.fromEntries(Object.entries(data || {}).slice(0, 32).map(([k, v]) => [String(k).slice(0, 64), String(v).slice(0, 512)])),
      apns: { payload: { aps: { sound: SOUND, badge: 1 } } }
    }};
  });
  const result = await sendPushViaRelay(env, messages);
  for (const token of result.invalid_tokens || []) {
    // 送信待ちの間にtokenが別アカウントへ再登録されても、現在の所有者を消さない。
    await env.DB.prepare("DELETE FROM push_tokens WHERE token=? AND user_id=?")
      .bind(token, userId).run();
  }
  return { sent: result.sent, code: result.code, token_count: result.token_count };
}

async function sendPush(env, userId, title, body, data) {
  return (await sendPushDetailed(env, userId, title, body, data)).sent;
}

/** 自分に試しに送る */
async function pushTest(env, me) {
  if (!(await userLimit(env, me.id, "push-test-hour", hourKey(), 3))) {
    return json({ error: "テスト回数が多すぎます" }, 429);
  }
  const n = await sendPush(env, me.id, "spota", "通知はこの音で届きます", { test: "1" });
  return json({ sent: n });
}

/* ============================================================
   本番通信モニター

   ユーザーが自分で開始した時だけ、一時的なbot投稿・DM・いいね・
   フラッシュを作る。PushはFCM受付だけを成功扱いにせず、端末受信・
   開封・画面上の確認を別々のreceiptとして記録する。
   ============================================================ */

const MONITOR_BOT_ID = "spota-system-monitor";

async function ensureMonitorBot(env) {
  const now = Date.now();
  await env.DB.prepare(`INSERT OR IGNORE INTO users
    (id,handle,display_name,bio,default_visibility,friend_precision,public_precision,
     publish_delay_sec,profile_public,created_at,profile_icon)
    VALUES (?, 'spota_monitor', 'Spotaモニター', '通信確認専用のシステムアカウントです。',
      'friends','hidden','hidden',0,0,?,'camera')`)
    .bind(MONITOR_BOT_ID, now).run();
}

async function monitorArtifact(env, runId, type, id, now) {
  await env.DB.prepare(`INSERT OR IGNORE INTO communication_monitor_artifacts
    (run_id,artifact_type,artifact_id,created_at) VALUES (?,?,?,?)`)
    .bind(runId, type, String(id), now || Date.now()).run();
}

async function createMonitorArtifacts(env, me, runId) {
  const now = Date.now(), steps = {
    post: false, message: false, like: false, flash: false, notification: false
  };
  await ensureMonitorBot(env);

  const oldFriendship = await env.DB.prepare(`SELECT id,status FROM friendships
    WHERE requester_id=? AND addressee_id=?`).bind(MONITOR_BOT_ID, me.id).first();
  if (oldFriendship) {
    await env.DB.prepare("UPDATE friendships SET status='accepted',updated_at=? WHERE id=?")
      .bind(now, oldFriendship.id).run();
    await monitorArtifact(env, runId, "friendship", oldFriendship.id, now);
  } else {
    const friendship = await env.DB.prepare(`INSERT INTO friendships
      (requester_id,addressee_id,status,created_at,updated_at)
      VALUES (?,?,'accepted',?,?)`).bind(MONITOR_BOT_ID, me.id, now, now).run();
    await monitorArtifact(env, runId, "friendship", friendship.meta.last_row_id, now);
  }

  const postId = uuid();
  const lat = 35.681236, lng = 139.767125;
  const [approxLat, approxLng] = snap(lat, lng, 500);
  const [areaLat, areaLng] = snap(lat, lng, 2000);
  await env.DB.prepare(`INSERT INTO posts
    (id,user_id,title,category,tag,place_name,body,lat,lng,approx_lat,approx_lng,
     area_lat,area_lng,taken_at,created_at,visibility,publish_at,social_announced_at)
    VALUES (?,?,'通信テスト','試','#通信テスト','Spota通信モニター',
      'この投稿は通信確認後に自動で消えます。',?,?,?,?,?,?,?,?,'friends',?,?)`)
    .bind(postId, MONITOR_BOT_ID, lat, lng, approxLat, approxLng, areaLat, areaLng,
      now, now, now, now).run();
  await monitorArtifact(env, runId, "post", postId, now);

  const assetResponse = await env.ASSETS.fetch(new Request("https://spota.invalid/icon-192.png"));
  if (!assetResponse.ok) throw new Error("monitor asset unavailable");
  const iconBytes = await assetResponse.arrayBuffer();
  const photoId = uuid();
  for (const variant of ["orig", "view", "thumb"]) {
    const key = `monitor/${runId}/${variant}.png`;
    await env.PHOTOS.put(key, iconBytes, { httpMetadata: { contentType: "image/png" } });
    await monitorArtifact(env, runId, "r2_object", key, now);
  }
  await env.DB.prepare(`INSERT INTO photos
    (id,post_id,user_id,key_orig,key_view,key_thumb,width,height,sort_order,created_at,
     moderation_state,moderation_view_state,moderation_thumb_state)
    VALUES (?,?,?,?,?,?,192,192,0,?,'ok','ok','ok')`)
    .bind(photoId, postId, MONITOR_BOT_ID, `monitor/${runId}/orig.png`,
      `monitor/${runId}/view.png`, `monitor/${runId}/thumb.png`, now).run();
  steps.post = true;

  const pair = directPair(MONITOR_BOT_ID, me.id);
  let conversation = await env.DB.prepare("SELECT id FROM conversations WHERE pair_key=?")
    .bind(pair).first();
  if (!conversation) {
    conversation = { id: uuid() };
    await env.DB.prepare(`INSERT INTO conversations(id,pair_key,created_at,updated_at)
      VALUES (?,?,?,?)`).bind(conversation.id, pair, now, now).run();
    await monitorArtifact(env, runId, "conversation", conversation.id, now);
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO conversation_members
      (conversation_id,user_id,joined_at,last_read_at,last_read_id,hidden_at)
      VALUES (?,?,?,0,'',NULL)
      ON CONFLICT(conversation_id,user_id) DO UPDATE SET hidden_at=NULL`)
      .bind(conversation.id, MONITOR_BOT_ID, now),
    env.DB.prepare(`INSERT INTO conversation_members
      (conversation_id,user_id,joined_at,last_read_at,last_read_id,hidden_at)
      VALUES (?,?,?,0,'',NULL)
      ON CONFLICT(conversation_id,user_id) DO UPDATE SET hidden_at=NULL`)
      .bind(conversation.id, me.id, now)
  ]);
  const messageId = uuid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO messages
      (id,conversation_id,sender_id,body,client_operation_id,created_at)
      VALUES (?,?,?,'通信モニターからのテストメッセージです。',?,?)`)
      .bind(messageId, conversation.id, MONITOR_BOT_ID, `monitor_${runId}`, now),
    env.DB.prepare("UPDATE conversations SET updated_at=? WHERE id=?").bind(now, conversation.id)
  ]);
  await monitorArtifact(env, runId, "message", messageId, now);
  const messageNotification = uuid();
  await env.DB.prepare(`INSERT INTO notifications
    (id,user_id,actor_id,kind,entity_type,entity_id,dedupe_key,created_at)
    VALUES (?,?,?,'message','conversation',?,?,?)`)
    .bind(messageNotification, me.id, MONITOR_BOT_ID, conversation.id,
      `monitor:${runId}:message`, now).run();
  await monitorArtifact(env, runId, "notification", messageNotification, now);
  steps.message = true;

  const targetPost = await env.DB.prepare(`SELECT id FROM posts
    WHERE user_id=? AND deleted_at IS NULL AND publish_at<=?
      AND visibility IN ('friends','public') ORDER BY created_at DESC LIMIT 1`)
    .bind(me.id, now).first();
  if (targetPost) {
    // 別利用者が同時に実行しているモニターのいいねを消さない。
    // 同じ利用者の前回分だけを対象投稿から除いて、今回の操作として作り直す。
    await env.DB.prepare("DELETE FROM post_likes WHERE post_id=? AND user_id=?")
      .bind(targetPost.id, MONITOR_BOT_ID).run();
    await env.DB.prepare("INSERT INTO post_likes(post_id,user_id,created_at) VALUES (?,?,?)")
      .bind(targetPost.id, MONITOR_BOT_ID, now).run();
    await monitorArtifact(env, runId, "like", targetPost.id, now);
    const likeNotification = uuid();
    await env.DB.prepare(`INSERT INTO notifications
      (id,user_id,actor_id,kind,entity_type,entity_id,dedupe_key,created_at)
      VALUES (?,?,?,'like','post',?,?,?)`)
      .bind(likeNotification, me.id, MONITOR_BOT_ID, targetPost.id,
        `monitor:${runId}:like`, now).run();
    await monitorArtifact(env, runId, "notification", likeNotification, now);
    steps.like = true;
  }

  await env.DB.prepare(`INSERT INTO post_flashes(post_id,user_id,recipient_count,created_at)
    VALUES (?,?,1,?)`).bind(postId, MONITOR_BOT_ID, now).run();
  await monitorArtifact(env, runId, "flash", postId, now);
  const flashNotification = uuid();
  await env.DB.prepare(`INSERT INTO notifications
    (id,user_id,actor_id,kind,entity_type,entity_id,dedupe_key,created_at)
    VALUES (?,?,?,'flash','post',?,?,?)`)
    .bind(flashNotification, me.id, MONITOR_BOT_ID, postId,
      `monitor:${runId}:flash`, now).run();
  await monitorArtifact(env, runId, "notification", flashNotification, now);
  steps.flash = true;

  const monitorNotification = uuid();
  await env.DB.prepare(`INSERT INTO notifications
    (id,user_id,actor_id,kind,entity_type,entity_id,dedupe_key,created_at)
    VALUES (?,? ,NULL,'monitor','monitor',?,?,?)`)
    .bind(monitorNotification, me.id, runId, `monitor:${runId}:push`, now).run();
  await monitorArtifact(env, runId, "notification", monitorNotification, now);
  steps.notification = true;
  return { steps, postId, conversationId: conversation.id };
}

async function runCommunicationMonitor(env, me) {
  if (!(await socialWriteLimit(env, me, "communication-monitor")) ||
      !(await userLimit(env, me.id, "communication-monitor-day", dayKey(), 3)))
    return json({ error: "通信モニターは1日3回までです" }, 429);
  const active = await env.DB.prepare(`SELECT id FROM communication_monitor_runs
    WHERE user_id=? AND status IN ('running','push_accepted','received','opened','confirmed','failed')
      AND expires_at>? LIMIT 1`).bind(me.id, Date.now()).first();
  if (active) return json({ error: "通信モニターはすでに実行中です", run_id: active.id }, 409);
  const registeredTokens = await pushTokensForUser(env, me.id);
  if (!registeredTokens.length)
    return json({ error: "この端末の通知先がまだ登録されていません", code: "device_not_registered" }, 409);
  if (!fcmRelayConfigured(env))
    return json({ error: "通知サーバーの設定が完了していません", code: "fcm_not_configured" }, 503);

  const id = uuid(), now = Date.now();
  await env.DB.prepare(`INSERT INTO communication_monitor_runs
    (id,user_id,status,steps_json,created_at,expires_at)
    VALUES (?,?,'running','{}',?,?)`).bind(id, me.id, now, now + 15 * 60 * 1000).run();
  try {
    const artifacts = await createMonitorArtifacts(env, me, id);
    const push = await sendPushDetailed(env, me.id, "Spota 通信確認",
      "投稿・DM・いいね・フラッシュの通信が完了しました",
      { monitor_run: id, post: artifacts.postId, conversation: artifacts.conversationId });
    const status = push.sent > 0 ? "push_accepted" : "failed";
    await env.DB.prepare(`UPDATE communication_monitor_runs
      SET status=?,steps_json=?,push_accepted_at=?,last_error=?
      WHERE id=?`).bind(status, JSON.stringify(artifacts.steps),
        push.sent > 0 ? Date.now() : null, push.sent > 0 ? "" : push.code, id).run();
    if (!push.sent) return json({ error: "FCMが通知を受理しませんでした", code: push.code, run_id: id }, 502);
    return json({ ok: true, run_id: id, status, steps: artifacts.steps,
      push_accepted: push.sent }, 202);
  } catch (error) {
    await env.DB.prepare(`UPDATE communication_monitor_runs
      SET status='failed',last_error=? WHERE id=?`).bind(safeLogError(error), id).run();
    return json({ error: "通信モニターを完了できませんでした", run_id: id }, 500);
  }
}

async function saveMonitorReceipt(request, env, me) {
  const parsed = await limitedJson(request, 2_000);
  if (parsed.error) return parsed.error;
  const runId = String(parsed.value.run_id || "");
  const event = String(parsed.value.event || "");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(runId) || !["received", "opened", "confirmed"].includes(event))
    return json({ error: "確認内容が不正です" }, 400);
  const run = await env.DB.prepare(`SELECT id,status,expires_at FROM communication_monitor_runs
    WHERE id=? AND user_id=?`).bind(runId, me.id).first();
  if (!run) return json({ error: "通信確認が見つかりません" }, 404);
  if (run.expires_at < Date.now()) return json({ error: "通信確認の期限が切れています" }, 410);
  const now = Date.now();
  await env.DB.prepare(`INSERT OR IGNORE INTO communication_monitor_receipts
    (run_id,user_id,event,created_at) VALUES (?,?,?,?)`).bind(runId, me.id, event, now).run();
  if (event === "received") {
    await env.DB.prepare(`UPDATE communication_monitor_runs
      SET received_at=COALESCE(received_at,?),status=CASE
        WHEN status IN ('running','push_accepted') THEN 'received' ELSE status END WHERE id=?`)
      .bind(now, runId).run();
  } else if (event === "opened") {
    await env.DB.prepare(`UPDATE communication_monitor_runs
      SET opened_at=COALESCE(opened_at,?),status=CASE
        WHEN status='confirmed' THEN status ELSE 'opened' END WHERE id=?`).bind(now, runId).run();
  } else {
    await env.DB.prepare(`UPDATE communication_monitor_runs
      SET confirmed_at=COALESCE(confirmed_at,?),status='confirmed' WHERE id=?`).bind(now, runId).run();
  }
  return json({ ok: true, event });
}

async function getCommunicationMonitor(id, env, me) {
  if (!(await socialReadLimit(env, me, "communication-monitor")))
    return json({ error: "確認回数が多すぎます" }, 429);
  const run = await env.DB.prepare(`SELECT id,status,steps_json,push_accepted_at,
      received_at,opened_at,confirmed_at,created_at,expires_at,last_error
    FROM communication_monitor_runs WHERE id=? AND user_id=?`).bind(id, me.id).first();
  if (!run) return json({ error: "通信確認が見つかりません" }, 404);
  let steps = {};
  try { steps = JSON.parse(run.steps_json || "{}"); } catch (_) { /* fail closed below */ }
  return json({ id: run.id, status: run.status, steps,
    push_accepted: !!run.push_accepted_at, received: !!run.received_at,
    opened: !!run.opened_at, confirmed: !!run.confirmed_at,
    created_at: run.created_at, expires_at: run.expires_at,
    error: run.status === "failed" ? run.last_error : "" });
}

async function cleanupCommunicationMonitors(env) {
  const cutoff = Date.now() - 15 * 60 * 1000;
  const runs = await env.DB.prepare(`SELECT r.id FROM communication_monitor_runs r
    WHERE r.created_at<? AND EXISTS (
      SELECT 1 FROM communication_monitor_artifacts a WHERE a.run_id=r.id)
    ORDER BY r.created_at LIMIT 6`).bind(cutoff).all();
  for (const run of (runs.results || [])) {
    const artifacts = await env.DB.prepare(`SELECT artifact_type,artifact_id
      FROM communication_monitor_artifacts WHERE run_id=?
      ORDER BY CASE artifact_type WHEN 'r2_object' THEN 0 WHEN 'notification' THEN 1
        WHEN 'like' THEN 2 WHEN 'message' THEN 3 WHEN 'flash' THEN 4
        WHEN 'post' THEN 5 WHEN 'friendship' THEN 6 ELSE 7 END`)
      .bind(run.id).all();
    for (const item of (artifacts.results || [])) {
      if (item.artifact_type === "r2_object") await env.PHOTOS.delete(item.artifact_id);
      else if (item.artifact_type === "notification")
        await env.DB.prepare("DELETE FROM notifications WHERE id=?").bind(item.artifact_id).run();
      else if (item.artifact_type === "like")
        await env.DB.prepare("DELETE FROM post_likes WHERE post_id=? AND user_id=?")
          .bind(item.artifact_id, MONITOR_BOT_ID).run();
      else if (item.artifact_type === "message")
        await env.DB.prepare("DELETE FROM messages WHERE id=? AND sender_id=?")
          .bind(item.artifact_id, MONITOR_BOT_ID).run();
      else if (item.artifact_type === "flash")
        await env.DB.prepare("DELETE FROM post_flashes WHERE post_id=? AND user_id=?")
          .bind(item.artifact_id, MONITOR_BOT_ID).run();
      else if (item.artifact_type === "post")
        await env.DB.prepare("DELETE FROM posts WHERE id=? AND user_id=?")
          .bind(item.artifact_id, MONITOR_BOT_ID).run();
      else if (item.artifact_type === "friendship")
        await env.DB.prepare("DELETE FROM friendships WHERE id=? AND requester_id=?")
          .bind(Number(item.artifact_id), MONITOR_BOT_ID).run();
    }
    await env.DB.prepare(`DELETE FROM conversations WHERE pair_key LIKE ?
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=conversations.id)`)
      .bind("%" + MONITOR_BOT_ID + "%").run();
    await env.DB.prepare(`UPDATE communication_monitor_runs
      SET status=CASE WHEN status='confirmed' THEN status ELSE 'expired' END WHERE id=?`)
      .bind(run.id).run();
    await env.DB.prepare("DELETE FROM communication_monitor_artifacts WHERE run_id=?")
      .bind(run.id).run();
  }
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

  const own = await env.DB.prepare(
    "SELECT * FROM posts WHERE id=? AND user_id=? AND deleted_at IS NULL"
  )
    .bind(postId, me.id).first();
  if (!own) return json({ error: "権限がありません" }, 403);
  if (own.visibility === "private") {
    return json({ error: "自分だけの思い出にはタグ付けできません" }, 409);
  }
  if (own.publish_at > Date.now() || !own.social_announced_at) {
    return json({ error: "公開準備が完了してからタグ付けできます" }, 409);
  }

  const now = Date.now();
  const who = me.display_name || me.handle || "フレンド";
  let n = 0;

  for (const uid of ids) {
    // フレンドでない相手には付けられない
    if (!(await areFriends(env, me.id, uid))) continue;
    if (await isBlocked(env, me.id, uid)) continue;

    const inserted = await env.DB.prepare(`
      INSERT INTO post_tags (post_id, user_id, tagged_by, status, created_at)
      VALUES (?,?,?, 'pending', ?)
      ON CONFLICT(post_id, user_id) DO NOTHING
    `).bind(postId, uid, me.id, now).run();
    if (inserted.meta && inserted.meta.changes === 1) {
      await sendPush(env, uid, who + " が思い出にタグ付けしました",
        publicLocationLabel(own.title || own.place_name || ""),
        { post: postId, tag: "1" });
      n++;
    }
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
           u.display_name, u.handle, u.id AS from_id,
           (SELECT ph.id FROM photos ph WHERE ph.post_id=p.id
             ORDER BY ph.sort_order, ph.created_at LIMIT 1) AS photo_id
      FROM post_tags t
      JOIN posts p ON p.id = t.post_id AND p.deleted_at IS NULL
      JOIN users u ON u.id = t.tagged_by
     WHERE t.user_id = ?1 AND t.status = 'pending'
       AND t.tagged_by = p.user_id
       AND p.publish_at <= ?2
       AND p.visibility IN ('public','friends')
       AND (p.visibility='public' OR EXISTS (
         SELECT 1 FROM friendships f
          WHERE f.status='accepted'
            AND ((f.requester_id=?1 AND f.addressee_id=p.user_id)
              OR (f.requester_id=p.user_id AND f.addressee_id=?1))
       ))
       AND NOT EXISTS (
         SELECT 1 FROM blocks b
          WHERE (b.blocker_id=?1 AND b.blocked_id=p.user_id)
             OR (b.blocker_id=p.user_id AND b.blocked_id=?1)
       )
     ORDER BY t.created_at DESC
     LIMIT 30
  `).bind(me.id, Date.now()).all();

  const out = [];
  for (const r of (rows.results || [])) {
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
      photo_id: r.photo_id || null,
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

  const now = Date.now();
  const friendsNow = await areFriends(env, me.id, src.user_id);
  if (t.tagged_by !== src.user_id || src.publish_at > now || src.visibility === "private" ||
      (src.visibility === "friends" && !friendsNow) || await isBlocked(env, me.id, src.user_id)) {
    return json({ error: "この思い出は現在受け取れません" }, 403);
  }

  // 受信者へ渡す座標も、投稿者が設定した現在の精度を必ず通す。
  let shared = null;
  if (src.fixed_lat != null && src.fixed_lng != null && validCoords(src.fixed_lat, src.fixed_lng)) {
    shared = [src.fixed_lat, src.fixed_lng];
  } else {
    const precision = friendsNow
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

  const newId = uuid();
  const claimId = "claim_" + Date.now() + "_" + newId;
  const staleClaim = Date.now() - 10 * 60 * 1000;
  const claim = await env.DB.prepare(
    `UPDATE post_tags SET new_post_id=?1
      WHERE post_id=?2 AND user_id=?3 AND status='pending'
        AND (new_post_id IS NULL OR
             (new_post_id LIKE 'claim_%' AND CAST(substr(new_post_id,7,13) AS INTEGER)<?4))`
  ).bind(claimId, postId, me.id, staleClaim).run();
  if (!claim.meta || claim.meta.changes !== 1) {
    return json({ error: "この思い出は処理中か、すでに返答済みです" }, 409);
  }

  try {
    const phs = await env.DB.prepare("SELECT * FROM photos WHERE post_id=?")
      .bind(postId).all();
    let newVisibility = ["private", "friends", "public"].includes(me.default_visibility)
      ? me.default_visibility : "private";
    if (newVisibility !== "private" &&
        !(await moderatePhotoRows(env, me, phs.results || []))) newVisibility = "private";

    const statements = [
      env.DB.prepare(`
        UPDATE post_tags SET status='accepted',new_post_id=?1
         WHERE post_id=?2 AND user_id=?3 AND tagged_by=?4 AND status='pending' AND new_post_id=?6
           AND EXISTS (
             SELECT 1 FROM posts p
              WHERE p.id=?2 AND p.user_id=?4 AND p.deleted_at IS NULL
                AND p.publish_at<=?5 AND p.visibility IN ('public','friends')
                AND (p.visibility='public' OR EXISTS (
                  SELECT 1 FROM friendships f WHERE f.status='accepted'
                    AND ((f.requester_id=?3 AND f.addressee_id=?4)
                      OR (f.requester_id=?4 AND f.addressee_id=?3))
                ))
                AND NOT EXISTS (
                  SELECT 1 FROM blocks b
                   WHERE (b.blocker_id=?3 AND b.blocked_id=?4)
                      OR (b.blocker_id=?4 AND b.blocked_id=?3)
                )
           )
      `).bind(newId, postId, me.id, src.user_id, Date.now(), claimId),
      env.DB.prepare(`
        INSERT INTO posts (
          id,user_id,place_id,title,category,tag,place_name,body,
          lat,lng,approx_lat,approx_lng,area_lat,area_lng,
          taken_at,created_at,visibility,publish_at
        ) SELECT ?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?
          FROM posts source
         WHERE source.id=? AND source.user_id=? AND source.deleted_at IS NULL
           AND source.publish_at<=? AND source.visibility IN ('public','friends')
           AND (source.visibility='public' OR EXISTS (
             SELECT 1 FROM friendships f WHERE f.status='accepted'
               AND ((f.requester_id=? AND f.addressee_id=source.user_id)
                 OR (f.requester_id=source.user_id AND f.addressee_id=?))
           ))
           AND NOT EXISTS (
             SELECT 1 FROM blocks b
              WHERE (b.blocker_id=? AND b.blocked_id=source.user_id)
                 OR (b.blocker_id=source.user_id AND b.blocked_id=?)
           )
           AND EXISTS (
             SELECT 1 FROM post_tags t
              WHERE t.post_id=source.id AND t.user_id=? AND t.status='accepted' AND t.new_post_id=?
           )
      `).bind(
        newId, me.id, src.place_id, src.title, src.category, src.tag,
        src.place_name, src.body,
        sharedLat, sharedLng, sharedApproxLat, sharedApproxLng, sharedAreaLat, sharedAreaLng,
        src.taken_at, now, newVisibility, now + (me.publish_delay_sec || 0) * 1000,
        postId, src.user_id, Date.now(), me.id, me.id, me.id, me.id, me.id, newId
      )
    ];
    // 写真は同じR2 objectを参照し、容量は複製しない。
    for (const ph of (phs.results || [])) {
      statements.push(env.DB.prepare(`
        INSERT INTO photos (id,post_id,user_id,key_orig,key_view,key_thumb,
                            width,height,sort_order,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?
         WHERE EXISTS (SELECT 1 FROM posts WHERE id=? AND user_id=?)
      `).bind(uuid(), newId, me.id, ph.key_orig, ph.key_view, ph.key_thumb,
              ph.width, ph.height, ph.sort_order, now, newId, me.id));
    }
    await env.DB.batch(statements);
    const made = await env.DB.prepare("SELECT 1 FROM posts WHERE id=? AND user_id=?")
      .bind(newId, me.id).first();
    if (!made) {
      await env.DB.prepare(
        "UPDATE post_tags SET status='pending',new_post_id=NULL WHERE post_id=? AND user_id=? AND new_post_id IN (?,?)"
      ).bind(postId, me.id, claimId, newId).run();
      return json({ error: "この思い出は現在受け取れません" }, 403);
    }
    return json({ ok: true, taken: true, id: newId });
  } catch (e) {
    await env.DB.prepare(
      "UPDATE post_tags SET status='pending',new_post_id=NULL WHERE post_id=? AND user_id=? AND new_post_id IN (?,?)"
    ).bind(postId, me.id, claimId, newId).run();
    throw e;
  }
}
