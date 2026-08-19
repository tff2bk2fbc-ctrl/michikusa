import http from "node:http";
import {createHmac, timingSafeEqual} from "node:crypto";
import {GoogleAuth} from "google-auth-library";

const PORT = Number(process.env.PORT || 8080);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGES = 8;
const CLOCK_SKEW_SECONDS = 300;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const seenNonces = new Map();

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
  });
}

function secretFrom(env) {
  const secret = String(env.FCM_RELAY_SHARED_SECRET || "");
  return secret.length >= 32 ? secret : null;
}

export function verifySignature({secret, timestamp, nonce, signature, body, now = Date.now()}) {
  if (!secret || !/^\d{10,12}$/.test(timestamp) || !/^[A-Za-z0-9_-]{20,120}$/.test(nonce) ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > CLOCK_SKEW_SECONDS)
    return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${nonce}.${body}`).digest();
  let actual;
  try { actual = Buffer.from(signature, "base64url"); } catch (_) { return false; }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function rememberNonce(nonce, now = Date.now()) {
  for (const [key, expiresAt] of seenNonces) if (expiresAt <= now) seenNonces.delete(key);
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, now + CLOCK_SKEW_SECONDS * 1000);
  // A process restart clears this cache; the short timestamp window limits replay exposure.
  if (seenNonces.size > 2048) {
    const first = seenNonces.keys().next().value;
    if (first) seenNonces.delete(first);
  }
  return true;
}

const SENSITIVE_DATA_KEYS = /^(?:lat|lng|latitude|longitude|location|email|ip|device[_-]?token)$/i;

function validateMessages(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > MAX_MESSAGES)
    return "messages must contain 1-8 entries";
  for (const entry of body.messages) {
    const message = entry && entry.message;
    if (!message || typeof message.token !== "string" || message.token.length < 20 || message.token.length > 4096 || /\s/.test(message.token))
      return "invalid FCM token";
    if (!message.notification || typeof message.notification.title !== "string" || typeof message.notification.body !== "string" ||
        message.notification.title.length > 120 || message.notification.body.length > 1000)
      return "invalid notification";
    if (message.data !== undefined) {
      if (!message.data || typeof message.data !== "object" || Array.isArray(message.data) || Object.keys(message.data).length > 32)
        return "invalid data";
      for (const [key, value] of Object.entries(message.data)) {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key) || SENSITIVE_DATA_KEYS.test(key) ||
            typeof value !== "string" || value.length > 512) return "invalid data field";
      }
    }
  }
  return null;
}

let authClientPromise;
async function getAccessToken() {
  if (!authClientPromise) {
    const auth = new GoogleAuth({scopes: [FCM_SCOPE]});
    authClientPromise = auth.getClient();
  }
  const client = await authClientPromise;
  const result = await client.getAccessToken();
  const token = typeof result === "string" ? result : result && result.token;
  if (!token) throw new Error("ADC access token unavailable");
  return token;
}

function isInvalidRegistration(status, payload) {
  if (status === 404) return true;
  const text = JSON.stringify(payload || "");
  return /UNREGISTERED|registration-token-not-registered/i.test(text);
}

export async function sendFcmMessages(messages, env, fetchImpl = fetch, tokenProvider = getAccessToken) {
  const project = String(env.FIREBASE_PROJECT_ID || "");
  if (!/^[a-z][a-z0-9-]{4,60}$/.test(project)) return {sent: 0, code: "project_not_configured", invalid_tokens: []};
  const accessToken = await tokenProvider();
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(project)}/messages:send`;
  const results = await Promise.all(messages.map(async (entry) => {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json"},
        body: JSON.stringify(entry),
        signal: AbortSignal.timeout(8_000)
      });
      let payload = null;
      try { payload = await response.json(); } catch (_) {}
      return {ok: response.ok, invalid: isInvalidRegistration(response.status, payload), token: entry.message.token};
    } catch (_) {
      return {ok: false, invalid: false, token: entry.message.token};
    }
  }));
  const sent = results.filter(result => result.ok).length;
  const invalid_tokens = results.filter(result => result.invalid).map(result => result.token);
  return {sent, code: sent ? "accepted" : "rejected", invalid_tokens};
}

export async function handleRelayRequest(request, env, options = {}) {
  const url = new URL(request.url);
  // Cloud Runのフロントエンドが予約する/healthzを避け、外部確認は/healthで行う。
  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) return json({ok: true});
  if (request.method !== "POST" || url.pathname !== "/send") return json({error: "not found"}, 404);
  const secret = secretFrom(env);
  if (!secret) return json({error: "relay is not configured"}, 503);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) return json({error: "request too large"}, 413);
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return json({error: "request too large"}, 413);
  const body = new TextDecoder().decode(raw);
  const timestamp = request.headers.get("X-Spota-Timestamp") || "";
  const nonce = request.headers.get("X-Spota-Nonce") || "";
  const signature = request.headers.get("X-Spota-Signature") || "";
  if (!verifySignature({secret, timestamp, nonce, signature, body, now: options.now || Date.now()}))
    return json({error: "unauthorized"}, 401);
  if (!rememberNonce(nonce, options.now || Date.now())) return json({error: "replayed request"}, 409);
  let parsed;
  try { parsed = JSON.parse(body); } catch (_) { return json({error: "invalid json"}, 400); }
  const validation = validateMessages(parsed);
  if (validation) return json({error: validation}, 400);
  try {
    const result = await sendFcmMessages(parsed.messages, env, options.fetchImpl || fetch, options.tokenProvider || getAccessToken);
    return json({sent: result.sent, code: result.code, invalid_tokens: result.invalid_tokens});
  } catch (_) {
    return json({error: "FCM unavailable", code: "fcm_unavailable", sent: 0, invalid_tokens: []}, 502);
  }
}

function sendHttpResponse(response, res) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  response.arrayBuffer().then(buffer => res.end(Buffer.from(buffer)));
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  let total = 0;
  req.on("data", chunk => { total += chunk.length; if (total <= MAX_BODY_BYTES) chunks.push(chunk); });
  req.on("end", async () => {
    try {
      const body = Buffer.concat(chunks, Math.min(total, MAX_BODY_BYTES));
      const request = new Request(`http://${req.headers.host || "localhost"}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
        duplex: "half"
      });
      sendHttpResponse(await handleRelayRequest(request, process.env), res);
    } catch (_) {
      res.statusCode = 500;
      res.end(JSON.stringify({error: "internal error"}));
    }
  });
});

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url)
  server.listen(PORT, "0.0.0.0", () => console.log(`FCM relay listening on ${PORT}`));
