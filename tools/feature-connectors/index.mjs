/**
 * Spota feature connector registry.
 *
 * This module is deliberately network-free.  A connector is only allowed to
 * make live requests after its terms, credentials, quota and security review
 * have been recorded outside the client and the connector is explicitly
 * enabled by the server.  Keeping the gate here prevents a UI flag or a
 * missing environment variable from accidentally turning on a paid API.
 */

const CONNECTORS = [
  {
    id: "cloudflare-map-api",
    label: "Cloudflare Worker / D1 / R2",
    kind: "first-party",
    state: "connected",
    mode: "live",
    dataClass: "derived-map-index",
    secret: false,
    notes: "既存アプリAPI。原本データではなく認証済みの軽量索引を配信する。"
  },
  {
    id: "firebase-auth-fcm",
    label: "Firebase Authentication / FCM relay",
    kind: "first-party",
    state: "connected",
    mode: "live",
    dataClass: "account-and-notification",
    secret: true,
    notes: "SecretはWorker/Cloud Run側だけで扱い、モバイルへ返さない。"
  },
  {
    id: "google-drive-raw-backup",
    label: "Google One (Drive) raw backup",
    kind: "storage",
    state: "connected",
    mode: "backup-only",
    dataClass: "public-source-archives",
    secret: true,
    notes: "アプリから直接読まず、管理者のインポート用原本バックアップに限定する。"
  },
  {
    id: "osm-derived-index",
    label: "OpenStreetMap derived place index",
    kind: "open-data",
    state: "staged",
    mode: "offline",
    dataClass: "coarse-public-places",
    secret: false,
    notes: "PBFをサーバー側で絞り込み、名称・カテゴリ・概略座標だけを配信する。"
  },
  {
    id: "wikidata-wikimedia-index",
    label: "Wikidata / Wikimedia derived index",
    kind: "open-data",
    state: "staged",
    mode: "offline",
    dataClass: "public-place-metadata",
    secret: false,
    notes: "本文・画像本体・利用者識別子は保存しない。"
  },
  {
    id: "wikipedia-action-api",
    label: "Japanese Wikipedia Action API",
    kind: "open-api",
    state: "staged",
    mode: "live",
    dataClass: "public-place-metadata",
    secret: false,
    notes: "認証済みWorkerの /api/wiki/search から、タイトル・公開座標だけを取得する。"
  },
  {
    id: "google-trends-alpha",
    label: "Google Trends API (alpha)",
    kind: "external-api",
    state: "pending-credentials",
    mode: "disabled",
    dataClass: "relative-search-interest",
    secret: true,
    notes: "ユーザーから承認済みとの連絡を受けたが、専用endpoint・資格情報・保存条件の確認まで外部通信を禁止する。"
  },
  {
    id: "serpapi",
    label: "SerpApi",
    kind: "external-api",
    state: "pending-terms",
    mode: "disabled",
    dataClass: "relative-search-interest",
    secret: true,
    notes: "商用の保存・派生・再表示条件と予算上限の確認待ち。"
  },
  {
    id: "x-api",
    label: "X API",
    kind: "external-api",
    state: "pending-approval",
    mode: "disabled",
    dataClass: "provider-native-trends",
    secret: true,
    notes: "use case承認、削除同期、pay-per-use上限の確認待ち。"
  },
  {
    id: "youtube-data-api",
    label: "YouTube Data API",
    kind: "external-api",
    state: "pending-credentials",
    mode: "disabled",
    dataClass: "youtube-only-analytics",
    secret: true,
    notes: "専用APIキー、quota、表示・保存要件の確認待ち。"
  },
  {
    id: "japan-47go",
    label: "JAPAN 47 GO",
    kind: "external-api",
    state: "pending-license",
    mode: "disabled",
    dataClass: "tourism-open-data",
    secret: true,
    notes: "問い合わせ返信と再利用許諾の確認待ち。"
  },
  {
    id: "dataforseo",
    label: "DataForSEO Trends",
    kind: "external-api",
    state: "deferred",
    mode: "disabled",
    dataClass: "relative-search-interest",
    secret: true,
    notes: "課金・DPA・再表示条件を確認するまで登録・課金・通信を行わない。"
  },
  {
    id: "gdelt-aggregate",
    label: "GDELT aggregate signal",
    kind: "external-api",
    state: "deferred",
    mode: "disabled",
    dataClass: "news-aggregate",
    secret: false,
    notes: "ニュース件数等の補助信号に限定し、本文・画像・長文スニペットは扱わない。"
  },
  {
    id: "tiktok-cross-user-trends",
    label: "TikTok cross-user trends",
    kind: "external-api",
    state: "blocked",
    mode: "disabled",
    dataClass: "social-cross-user-content",
    secret: true,
    notes: "商用横断トレンドの公式許諾がないため、非公式API・スクレイピングを禁止する。"
  }
];

const SAFE_OFFLINE_MODES = new Set(["offline", "backup-only"]);

export function listConnectors() {
  return CONNECTORS.map((connector) => ({ ...connector }));
}

export function getConnector(id) {
  const connector = CONNECTORS.find((candidate) => candidate.id === id);
  return connector ? { ...connector } : null;
}

export function enabledOfflineConnectors() {
  return listConnectors().filter((connector) =>
    connector.mode === "offline" || connector.mode === "backup-only"
  );
}

/**
 * Returns true only for the explicitly approved, server-side modes.
 * `allowLive` is intentionally opt-in and is not read from a client flag.
 */
export function canConnect(id, { allowLive = false, approved = false } = {}) {
  const connector = getConnector(id);
  if (!connector) return false;
  if (SAFE_OFFLINE_MODES.has(connector.mode)) return true;
  if (!allowLive || !approved) return false;
  return connector.mode === "live" && connector.state === "connected";
}

export function assertConnectable(id, options = {}) {
  if (!canConnect(id, options)) {
    const connector = getConnector(id);
    const reason = connector
      ? `${connector.label} is not approved for live connection`
      : `unknown connector: ${id}`;
    const error = new Error(reason);
    error.code = "CONNECTOR_NOT_APPROVED";
    throw error;
  }
  return getConnector(id);
}

export function publicConnectionSummary() {
  return listConnectors().map(({ id, label, kind, state, mode, dataClass, notes }) => ({
    id,
    label,
    kind,
    state,
    mode,
    dataClass,
    notes
  }));
}
