const ADDRESS_SHARD_WINDOWS = [
  ["ADDR_HOKKAIDO", [[40.9, 138.7, 46.3, 149.1]]],
  ["ADDR_TOHOKU", [[36.6, 138.4, 41.8, 142.7]]],
  ["ADDR_TOKYO", [
    [35.40, 138.70, 36.10, 140.20],
    [29.50, 138.40, 35.50, 140.60],
    [24.00, 140.40, 28.80, 143.30],
    [19.50, 135.00, 21.60, 137.60],
    [23.00, 152.40, 25.60, 154.60]
  ]],
  ["ADDR_SOUTH_KANTO", [[34.6, 138.6, 36.3, 141.2]]],
  ["ADDR_NORTH_KANTO", [[35.5, 138.0, 37.4, 141.2]]],
  ["ADDR_CHUBU", [[34.3, 135.2, 38.8, 140.6]]],
  ["ADDR_KINKI", [[33.2, 133.6, 36.4, 137.6]]],
  ["ADDR_CHUGOKU_SHIKOKU", [[32.3, 130.3, 37.5, 136.7]]],
  ["ADDR_KYUSHU_OKINAWA", [[23.5, 122.0, 35.1, 132.8]]]
];

export const MAX_MAP_PLACE_BOUNDS_DEGREES = 0.35;
export const MAX_MAP_PLACE_RESULTS = 200;
const PUBLIC_NEARBY_SOURCES = new Set(["mlit-n02", "geonames"]);

function intersects(bounds, box) {
  return bounds.s <= box[2] && bounds.n >= box[0] && bounds.w <= box[3] && bounds.e >= box[1];
}

export function selectMapAddressDatabases(env, bounds) {
  return ADDRESS_SHARD_WINDOWS.flatMap(function ([binding, windows]) {
    const db = env[binding];
    return db && windows.some((box) => intersects(bounds, box)) ? [{ binding, db }] : [];
  });
}

function safeText(value, max) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}

function normalizedName(value) {
  return safeText(value, 200).normalize("NFKC").toLocaleLowerCase("ja").replace(/\s+/g, "");
}

function sourceInfo(provider, id, title) {
  const sourceId = safeText(id, 100);
  if (provider === "jawiki") {
    return {
      provider: "Wikipedia",
      id: sourceId,
      url: "https://ja.wikipedia.org/wiki/" + encodeURIComponent(String(title || "").replaceAll(" ", "_"))
    };
  }
  if (provider === "geonames") {
    return { provider: "GeoNames", id: sourceId, url: "https://www.geonames.org/" + encodeURIComponent(sourceId) + "/" };
  }
  if (provider !== "mlit-n02") return null;
  return {
    provider: "国土交通省 国土数値情報 N02",
    id: sourceId,
    url: "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html"
  };
}

function wikipediaCategory(title, type) {
  const value = String(title || "") + " " + String(type || "");
  if (/温泉|銭湯|浴場/.test(value)) return "湯";
  if (/神社|寺院|寺|大社|神宮|仏閣/.test(value)) return "社";
  if (/公園|庭園|植物園|渓谷|滝|湖|forest|waterbody|isle/.test(value)) return "園";
  if (/図書館|書店/.test(value)) return "本";
  if (/駅|railwaystation/.test(value)) return "駅";
  return "景";
}

function nearbyCategory(row) {
  if (row.kind === "station") return "駅";
  const value = String(row.name || "") + " " + String(row.detail || "");
  if (/SHRN|TMPL|\bCH\b|神社|寺院|寺|神宮/.test(value)) return "社";
  if (/LIBR|図書館/.test(value)) return "本";
  if (/PRK|公園|庭園|植物園/.test(value)) return "園";
  return "景";
}

function mapNearbyRow(row) {
  const lat = Number(row.lat_e6) / 1e6, lng = Number(row.lng_e6) / 1e6;
  const name = safeText(row.name, 200), source = safeText(row.source, 40);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || !PUBLIC_NEARBY_SOURCES.has(source)) return null;
  const sourceId = safeText(row.id, 100), sourceRecord = sourceInfo(source, sourceId, name);
  if (!sourceId || !sourceRecord) return null;
  return {
    id: source + ":" + safeText(row.kind, 40) + ":" + sourceId,
    name,
    category: nearbyCategory(row),
    detail: row.kind === "station" ? safeText(row.detail, 160) : row.kind === "nature" ? "自然地名" : "公開施設",
    lat, lng,
    sources: [sourceRecord]
  };
}

function mapWikipediaRow(row) {
  const lat = Number(row.lat_e6) / 1e6, lng = Number(row.lng_e6) / 1e6;
  const name = safeText(row.title, 200), sourceId = String(row.page_id || "");
  if (!name || !sourceId || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    id: "jawiki:" + sourceId,
    name,
    category: wikipediaCategory(name, row.type),
    detail: "Wikipedia",
    lat, lng,
    sources: [sourceInfo("jawiki", sourceId, name)]
  };
}

function mergeMapPlaces(rows, limit) {
  const exact = new Set(), semantic = new Map(), merged = [];
  for (const row of rows) {
    if (!row || exact.has(row.id)) continue;
    exact.add(row.id);
    const key = normalizedName(row.name) + "|" + row.category + "|" + row.lat.toFixed(3) + "|" + row.lng.toFixed(3);
    const existing = semantic.get(key);
    if (existing) {
      const sourceIds = new Set(existing.sources.map((source) => source.provider + ":" + source.id));
      for (const source of row.sources) {
        const sourceKey = source.provider + ":" + source.id;
        if (!sourceIds.has(sourceKey)) existing.sources.push(source);
      }
      continue;
    }
    semantic.set(key, row);
    merged.push(row);
    if (merged.length >= limit) break;
  }
  return merged;
}

function alternateSources(first, second, limit) {
  const output = [];
  for (let index = 0; output.length < limit && (index < first.length || index < second.length); index++) {
    if (index < first.length) output.push(first[index]);
    if (output.length < limit && index < second.length) output.push(second[index]);
  }
  return output;
}

async function queryNearbyPlaces(db, bounds, limit) {
  if (!db || limit < 1) return [];
  const minLat = Math.floor(bounds.s * 1e6), maxLat = Math.ceil(bounds.n * 1e6);
  const minLng = Math.floor(bounds.w * 1e6), maxLng = Math.ceil(bounds.e * 1e6);
  const centerLat = Math.round((bounds.s + bounds.n) * 500_000);
  const centerLng = Math.round((bounds.w + bounds.e) * 500_000);
  try {
    const result = await db.prepare(`
      SELECT id,kind,name,detail,lat_e6,lng_e6,source
        FROM nearby_places
       WHERE grid_lat BETWEEN ? AND ? AND grid_lng BETWEEN ? AND ?
         AND lat_e6 BETWEEN ? AND ? AND lng_e6 BETWEEN ? AND ?
         AND source IN ('mlit-n02','geonames')
         AND (kind IN ('station','nature') OR
              (kind='facility' AND detail IN ('MUS','SHRN','TMPL','CH','CSTL','PAL','LIBR','STDM')))
       ORDER BY ((lat_e6-?)*(lat_e6-?))+((lng_e6-?)*(lng_e6-?))
       LIMIT ?
    `).bind(
      Math.floor(bounds.s * 100), Math.floor(bounds.n * 100),
      Math.floor(bounds.w * 100), Math.floor(bounds.e * 100),
      minLat, maxLat, minLng, maxLng,
      centerLat, centerLat, centerLng, centerLng, limit
    ).all();
    return (result.results || []).map(mapNearbyRow).filter(Boolean);
  } catch (error) {
    return [];
  }
}

async function queryWikipediaPlaces(selected, bounds, limit) {
  if (!selected.length || limit < 1) return [];
  const minLat = Math.floor(bounds.s * 1e6), maxLat = Math.ceil(bounds.n * 1e6);
  const minLng = Math.floor(bounds.w * 1e6), maxLng = Math.ceil(bounds.e * 1e6);
  const centerLat = Math.round((bounds.s + bounds.n) * 500_000);
  const centerLng = Math.round((bounds.w + bounds.e) * 500_000);
  const perDatabase = Math.min(limit, Math.ceil(limit / selected.length) + 16);
  const found = [];
  // nearby_placesの1接続と合わせ、Workersの同時外部接続6本以内に保つ。
  for (let offset = 0; offset < selected.length; offset += 5) {
    const batch = await Promise.all(selected.slice(offset, offset + 5).map(async function ({ db }) {
      try {
        const result = await db.prepare(`
          SELECT page_id,title,type,lat_e6,lng_e6
            FROM wikipedia_places
           WHERE grid_lat BETWEEN ? AND ? AND grid_lng BETWEEN ? AND ?
             AND lat_e6 BETWEEN ? AND ? AND lng_e6 BETWEEN ? AND ?
           ORDER BY ((lat_e6-?)*(lat_e6-?))+((lng_e6-?)*(lng_e6-?))
           LIMIT ?
        `).bind(
          Math.floor(bounds.s * 100), Math.floor(bounds.n * 100),
          Math.floor(bounds.w * 100), Math.floor(bounds.e * 100),
          minLat, maxLat, minLng, maxLng,
          centerLat, centerLat, centerLng, centerLng, perDatabase
        ).all();
        return result.results || [];
      } catch (error) {
        // 地域ごとの段階導入中は、その地域データだけを空として継続する。
        return [];
      }
    }));
    found.push(...batch.flat());
  }
  return found.map(mapWikipediaRow).filter(Boolean)
    .sort((a, b) => ((a.lat-centerLat/1e6)**2+(a.lng-centerLng/1e6)**2) -
                    ((b.lat-centerLat/1e6)**2+(b.lng-centerLng/1e6)**2));
}

export async function queryOpenMapPlaces(env, bounds, requestedLimit) {
  const limit = Math.max(1, Math.min(MAX_MAP_PLACE_RESULTS, Math.trunc(Number(requestedLimit) || 120)));
  const selected = selectMapAddressDatabases(env, bounds);
  if (!selected.length) return { places: [], truncated: false };
  // nearby_placesは現行D1では全国同一の公開データを持つため、必ず1DBだけを読む。
  const nearbyDb = env.ADDR_TOKYO || selected[0].db;
  const [nearby, wikipedia] = await Promise.all([
    queryNearbyPlaces(nearbyDb, bounds, limit),
    queryWikipediaPlaces(selected, bounds, limit)
  ]);
  const interleaved = alternateSources(nearby, wikipedia, limit);
  return {
    places: mergeMapPlaces(interleaved, limit),
    truncated: nearby.length >= limit || wikipedia.length >= limit
  };
}

export const MAP_PLACE_ATTRIBUTIONS = [
  { provider: "国土交通省 国土数値情報", url: "https://nlftp.mlit.go.jp/ksj/" },
  { provider: "GeoNames", url: "https://www.geonames.org/" },
  { provider: "Wikipedia", url: "https://ja.wikipedia.org/" }
];
