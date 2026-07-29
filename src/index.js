const HP = "https://webservice.recruit.co.jp/hotpepper/gourmet/v1/";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return json({ ok: true, hasKey: !!env.HOTPEPPER_KEY });
    }
    if (url.pathname === "/api/hotpepper") {
      try {
        return await hotpepper(url, env);
      } catch (e) {
        return json({ error: "Worker: " + (e && e.message) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};

async function hotpepper(url, env) {
  const key = env.HOTPEPPER_KEY;
  if (!key) return json({ error: "HOTPEPPER_KEY が未設定です" }, 500);

  const lat = url.searchParams.get("lat");
  const lng = url.searchParams.get("lng");
  const range = url.searchParams.get("range") || "5";
  if (!lat || !lng) return json({ error: "lat / lng が必要です" }, 400);

  const shops = [];
  let available = 0;

  for (let page = 0; page < 2; page++) {
    const api = new URL(HP);
    api.searchParams.set("key", key);
    api.searchParams.set("lat", lat);
    api.searchParams.set("lng", lng);
    api.searchParams.set("range", range);
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
        hpid: s.id,
        n: s.name,
        lat: Number(s.lat),
        lng: Number(s.lng),
        genre: s.genre ? s.genre.code : "",
        gname: s.genre ? s.genre.name : "",
        addr: s.address || "",
        budget: s.budget ? s.budget.name : "",
        url: s.urls ? s.urls.pc : "",
        photo: s.photo && s.photo.mobile ? s.photo.mobile.l : ""
      });
    }
    if (list.length < 100 || shops.length >= available) break;
  }

  return json({ count: shops.length, available: available, shops: shops });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
