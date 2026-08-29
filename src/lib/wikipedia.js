const WIKIPEDIA_API = "https://ja.wikipedia.org/w/api.php";
const WIKIPEDIA_UA = "Spota/1.0 (+https://github.com/tff2bk2fbc-ctrl/michikusa)";
const MAX_RESPONSE_BYTES = 64 * 1024;

export class WikipediaApiError extends Error {
  constructor(code, status = 502, retryAfter = "") {
    super(code);
    this.name = "WikipediaApiError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function validQuery(value) {
  const query = String(value || "").trim();
  if (!query || query.length > 80 || /[\u0000-\u001f\u007f]/.test(query)) return "";
  return query;
}

function finiteCoordinate(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  // 公開地名の検索結果でも、必要以上の小数を返さない。
  return Math.round(number * 10_000) / 10_000;
}

function safeTitle(value) {
  return String(value || "").replace(/[<>\u0000-\u001f]/g, "").slice(0, 240);
}

function pageUrl(title) {
  return "https://ja.wikipedia.org/wiki/" + encodeURIComponent(title.replaceAll(" ", "_"));
}

async function readBodyLimited(response) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new WikipediaApiError("response_too_large", 502);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const bytes = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value || []);
      total += bytes.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("response_too_large").catch(() => {});
        throw new WikipediaApiError("response_too_large", 502);
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(merged);
}

export async function fetchWikipediaPlaceSearch(value, { limit = 5, fetchImpl = globalThis.fetch } = {}) {
  const query = validQuery(value);
  if (!query) throw new WikipediaApiError("invalid_query", 400);
  const resultLimit = Math.min(5, Math.max(1, Number.parseInt(String(limit), 10) || 5));
  if (typeof fetchImpl !== "function") throw new WikipediaApiError("upstream_unavailable", 502);

  const url = new URL(WIKIPEDIA_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", query);
  url.searchParams.set("gsrnamespace", "0");
  url.searchParams.set("gsrlimit", String(resultLimit));
  url.searchParams.set("prop", "coordinates|pageprops");
  url.searchParams.set("coprimary", "all");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  // バッチではないが、混雑時は待機して負荷を増やさない。
  url.searchParams.set("maxlag", "5");

  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "User-Agent": WIKIPEDIA_UA,
        "Api-User-Agent": WIKIPEDIA_UA
      },
      redirect: "error",
      signal: AbortSignal.timeout(8_000)
    });
  } catch (error) {
    throw new WikipediaApiError("upstream_unavailable", 502);
  }

  const retryAfter = String(response.headers?.get?.("Retry-After") || "").slice(0, 32);
  if (response.status === 429 || response.status === 503) {
    throw new WikipediaApiError("rate_limited", 503, retryAfter);
  }
  if (!response.ok) throw new WikipediaApiError("upstream_unavailable", 502);

  const declaredLength = Number(response.headers?.get?.("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new WikipediaApiError("response_too_large", 502);
  }

  let body;
  try {
    body = await readBodyLimited(response);
  } catch (error) {
    if (error instanceof WikipediaApiError) throw error;
    throw new WikipediaApiError("upstream_unavailable", 502);
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (error) {
    throw new WikipediaApiError("invalid_upstream_response", 502);
  }
  if (data?.error) throw new WikipediaApiError("upstream_unavailable", 502);

  const pages = Array.isArray(data?.query?.pages) ? data.query.pages : [];
  const results = pages.slice(0, resultLimit).map((page) => {
    const title = safeTitle(page?.title);
    const coordinate = Array.isArray(page?.coordinates)
      ? page.coordinates.find((item) => item && item.primary !== false) || page.coordinates[0]
      : null;
    const lat = finiteCoordinate(coordinate?.lat, -90, 90);
    const lng = finiteCoordinate(coordinate?.lon, -180, 180);
    const pageid = Number.isSafeInteger(page?.pageid) ? page.pageid : null;
    return {
      pageid,
      title,
      coordinates: lat === null || lng === null ? null : { lat, lng },
      url: title ? pageUrl(title) : "",
      source: "Japanese Wikipedia (Wikimedia API)",
      attribution: "Wikipedia contributors / Wikimedia Foundation"
    };
  }).filter((item) => item.title);

  return {
    results,
    source: "https://ja.wikipedia.org/w/api.php",
    license: "記事本文・画像は取得しない。記事ごとのライセンスと帰属表示はリンク先で確認する",
    retrievedAt: new Date().toISOString()
  };
}
