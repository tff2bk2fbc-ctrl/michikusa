import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./global.css";

type Summary = {
  photoRecords: number;
  publicLocationRecords: number;
  missingLocationRecords: number;
  uploadFailures: number;
  moderationPending: number;
};
type Region = { label: string; records: number; qualityAlerts: number };
type Source = { id: string; name: string; status: "ready" | "review" | "blocked"; license: string; lastChecked: string };

const atlasRoot = document.getElementById("atlas-root");
const atlasSummaryGrid = document.getElementById("summary-grid");
const atlasDetailsContent = document.getElementById("details-content");
const atlasStatusText = document.getElementById("atlas-status");
const atlasGeneratedAt = document.getElementById("generated-at");
const atlasRefreshButton = document.getElementById("refresh-button");
if (!atlasRoot || !atlasSummaryGrid || !atlasDetailsContent || !atlasStatusText || !atlasGeneratedAt || !(atlasRefreshButton instanceof HTMLButtonElement)) {
  throw new Error("atlas_ui_missing_required_element");
}
const root = atlasRoot;
const summaryGrid = atlasSummaryGrid;
const detailsContent = atlasDetailsContent;
const statusText = atlasStatusText;
const generatedAt = atlasGeneratedAt;
const refreshButton = atlasRefreshButton;

const app = new App({ name: "Spota Data Atlas", version: "0.1.0" });

function setStatus(message: string) {
  statusText.textContent = message;
}

function hostContextChanged(context: McpUiHostContext) {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  const insets = context.safeAreaInsets;
  if (insets) {
    root.style.paddingTop = `${Math.max(28, insets.top)}px`;
    root.style.paddingRight = `${Math.max(20, insets.right)}px`;
    root.style.paddingBottom = `${Math.max(36, insets.bottom)}px`;
    root.style.paddingLeft = `${Math.max(20, insets.left)}px`;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseSummary(result: CallToolResult): { mode: "fixture"; generatedAt: string; summary: Summary } | null {
  const data = asObject(result.structuredContent);
  const summary = asObject(data?.summary);
  if (data?.mode !== "fixture" || typeof data.generatedAt !== "string" || !summary) return null;
  const values = ["photoRecords", "publicLocationRecords", "missingLocationRecords", "uploadFailures", "moderationPending"] as const;
  const parsed = Object.fromEntries(values.map((key) => [key, finiteCount(summary[key])])) as Partial<Summary>;
  if (values.some((key) => parsed[key] === null || parsed[key] === undefined)) return null;
  return { mode: "fixture", generatedAt: data.generatedAt, summary: parsed as Summary };
}

function parseDetails(result: CallToolResult): { regions: Region[]; sources: Source[] } | null {
  const data = asObject(result.structuredContent);
  if (!Array.isArray(data?.regions) || !Array.isArray(data.sources)) return null;
  const regions: Region[] = [];
  for (const item of data.regions.slice(0, 20)) {
    const row = asObject(item);
    const records = finiteCount(row?.records);
    const qualityAlerts = finiteCount(row?.qualityAlerts);
    if (typeof row?.label !== "string" || records === null || qualityAlerts === null) return null;
    regions.push({ label: row.label, records, qualityAlerts });
  }
  const sources: Source[] = [];
  for (const item of data.sources.slice(0, 20)) {
    const row = asObject(item);
    if (typeof row?.id !== "string" || typeof row.name !== "string" || typeof row.license !== "string" || typeof row.lastChecked !== "string") return null;
    if (row.status !== "ready" && row.status !== "review" && row.status !== "blocked") return null;
    sources.push({ id: row.id, name: row.name, status: row.status, license: row.license, lastChecked: row.lastChecked });
  }
  return { regions, sources };
}

function renderSummary(parsed: { generatedAt: string; summary: Summary }) {
  const labels: Array<[keyof Summary, string]> = [
    ["photoRecords", "写真レコード"],
    ["publicLocationRecords", "公開位置あり"],
    ["missingLocationRecords", "位置情報なし"],
    ["uploadFailures", "アップロード失敗"],
    ["moderationPending", "モデレーション待ち"],
  ];
  summaryGrid.replaceChildren(...labels.map(([key, label]) => {
    const item = document.createElement("div");
    item.className = "summary-item";
    const term = document.createElement("dt");
    term.textContent = label;
    const value = document.createElement("dd");
    value.textContent = parsed.summary[key].toLocaleString("ja-JP");
    item.append(term, value);
    return item;
  }));
  generatedAt.textContent = `集計日 ${parsed.generatedAt.slice(0, 10)}`;
  summaryGrid.setAttribute("aria-busy", "false");
}

function addCell(row: HTMLTableRowElement, text: string) {
  const cell = document.createElement("td");
  cell.textContent = text;
  row.append(cell);
}

function renderDetails(parsed: { regions: Region[]; sources: Source[] }) {
  const regionPanel = document.createElement("section");
  regionPanel.className = "atlas-panel";
  const regionHeading = document.createElement("h3");
  regionHeading.textContent = "地域別の件数";
  const regionTable = document.createElement("table");
  regionTable.className = "atlas-table";
  const regionCaption = document.createElement("caption");
  regionCaption.textContent = "地域別の写真レコードと品質注意件数";
  const regionHead = document.createElement("tr");
  for (const label of ["地域", "レコード", "注意"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    regionHead.append(cell);
  }
  const regionBody = document.createElement("tbody");
  for (const region of parsed.regions) {
    const row = document.createElement("tr");
    addCell(row, region.label);
    addCell(row, region.records.toLocaleString("ja-JP"));
    addCell(row, region.qualityAlerts.toLocaleString("ja-JP"));
    regionBody.append(row);
  }
  const regionHeader = document.createElement("thead");
  regionHeader.append(regionHead);
  regionTable.append(regionCaption, regionHeader, regionBody);
  regionPanel.append(regionHeading, regionTable);

  const sourcePanel = document.createElement("section");
  sourcePanel.className = "atlas-panel";
  const sourceHeading = document.createElement("h3");
  sourceHeading.textContent = "データソース";
  const sourceTable = document.createElement("table");
  sourceTable.className = "atlas-table";
  const sourceCaption = document.createElement("caption");
  sourceCaption.textContent = "データソースのライセンス確認状態";
  const sourceHead = document.createElement("tr");
  for (const label of ["ソース", "状態", "ライセンス", "確認日"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    sourceHead.append(cell);
  }
  const sourceBody = document.createElement("tbody");
  const statusLabel: Record<Source["status"], string> = { ready: "確認済み", review: "要確認", blocked: "停止" };
  for (const source of parsed.sources) {
    const row = document.createElement("tr");
    addCell(row, source.name);
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "atlas-status-badge";
    badge.dataset.status = source.status;
    badge.textContent = statusLabel[source.status];
    statusCell.append(badge);
    row.append(statusCell);
    addCell(row, source.license);
    addCell(row, source.lastChecked);
    sourceBody.append(row);
  }
  const sourceHeader = document.createElement("thead");
  sourceHeader.append(sourceHead);
  sourceTable.append(sourceCaption, sourceHeader, sourceBody);
  sourcePanel.append(sourceHeading, sourceTable);

  detailsContent.replaceChildren(regionPanel, sourcePanel);
  detailsContent.setAttribute("aria-busy", "false");
}

async function loadAtlas() {
  refreshButton.disabled = true;
  setStatus("集計を読み込んでいます。");
  summaryGrid.setAttribute("aria-busy", "true");
  detailsContent.setAttribute("aria-busy", "true");
  try {
    const summaryResult = await app.callServerTool({ name: "atlas-summary", arguments: {} });
    const summary = parseSummary(summaryResult);
    if (!summary) throw new Error("atlas_summary_invalid");
    renderSummary(summary);
    const detailResult = await app.callServerTool({ name: "atlas-details", arguments: {} });
    const details = parseDetails(detailResult);
    if (!details) throw new Error("atlas_details_invalid");
    renderDetails(details);
    setStatus("集計を表示しました。");
  } catch {
    summaryGrid.setAttribute("aria-busy", "false");
    detailsContent.setAttribute("aria-busy", "false");
    setStatus("集計を読み込めませんでした。もう一度お試しください。");
  } finally {
    refreshButton.disabled = false;
  }
}

app.onhostcontextchanged = hostContextChanged;
app.ontoolresult = (result) => {
  const summary = parseSummary(result);
  if (summary) renderSummary(summary);
};
app.onteardown = async () => ({});
app.onerror = () => setStatus("接続を確認できませんでした。");
refreshButton.addEventListener("click", () => { void loadAtlas(); });

app.connect().then(() => {
  const context = app.getHostContext();
  if (context) hostContextChanged(context);
  void loadAtlas();
}).catch(() => setStatus("MCPホストへ接続できませんでした。"));
