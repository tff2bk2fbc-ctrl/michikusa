import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;
const FIXTURE_PATH = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "data", "atlas-fixture.json")
  : path.join(import.meta.dirname, "..", "data", "atlas-fixture.json");
const MAX_RESPONSE_BYTES = 16 * 1024;

const statusSchema = z.enum(["ready", "review", "blocked"]);
const snapshotSchema = z.object({
  mode: z.literal("fixture"),
  generatedAt: z.string().datetime(),
  summary: z.object({
    photoRecords: z.number().int().nonnegative(),
    publicLocationRecords: z.number().int().nonnegative(),
    missingLocationRecords: z.number().int().nonnegative(),
    uploadFailures: z.number().int().nonnegative(),
    moderationPending: z.number().int().nonnegative(),
  }),
  regions: z.array(z.object({
    label: z.string().min(1).max(40),
    records: z.number().int().nonnegative(),
    qualityAlerts: z.number().int().nonnegative(),
  })).max(20),
  sources: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    name: z.string().min(1).max(80),
    status: statusSchema,
    license: z.string().min(1).max(80),
    lastChecked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })).max(20),
});

export type AtlasSnapshot = z.infer<typeof snapshotSchema>;

async function readSnapshot(): Promise<AtlasSnapshot> {
  const raw = await fs.readFile(FIXTURE_PATH, "utf8");
  return snapshotSchema.parse(JSON.parse(raw));
}

function textResult(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  const result = { content: [{ type: "text" as const, text }], structuredContent };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("atlas_response_too_large");
  }
  return result;
}

function summaryResult(snapshot: AtlasSnapshot): CallToolResult {
  const { summary } = snapshot;
  return textResult(
    "Spota Data Atlasのサンプル集計です。写真原本、EXIF、正確な位置は含みません。",
    {
      mode: snapshot.mode,
      generatedAt: snapshot.generatedAt,
      summary,
    },
  );
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "Spota Data Atlas",
    version: "0.1.0",
  });
  const summaryResourceUri = "ui://spota-data-atlas/summary.html";

  registerAppTool(
    server,
    "atlas-summary",
    {
      title: "Spotaデータ品質の概要",
      description:
        "匿名化されたサンプル集計から、写真保存と位置情報品質の概要を読み取ります。読み取り専用です。",
      inputSchema: {},
      outputSchema: z.object({
        mode: z.literal("fixture"),
        generatedAt: z.string(),
        summary: z.object({
          photoRecords: z.number().int().nonnegative(),
          publicLocationRecords: z.number().int().nonnegative(),
          missingLocationRecords: z.number().int().nonnegative(),
          uploadFailures: z.number().int().nonnegative(),
          moderationPending: z.number().int().nonnegative(),
        }),
      }),
      _meta: {
        ui: {
          resourceUri: summaryResourceUri,
          visibility: ["model", "app"],
        },
      },
    },
    async () => summaryResult(await readSnapshot()),
  );

  registerAppTool(
    server,
    "atlas-details",
    {
      title: "Spotaデータ品質の詳細",
      description:
        "匿名化されたサンプル集計の地域別件数とデータソース状態を読み取ります。読み取り専用です。",
      inputSchema: {},
      outputSchema: z.object({
        mode: z.literal("fixture"),
        generatedAt: z.string(),
        regions: z.array(z.object({
          label: z.string(),
          records: z.number().int().nonnegative(),
          qualityAlerts: z.number().int().nonnegative(),
        })),
        sources: z.array(z.object({
          id: z.string(),
          name: z.string(),
          status: statusSchema,
          license: z.string(),
          lastChecked: z.string(),
        })),
      }),
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async () => {
      const snapshot = await readSnapshot();
      return textResult(
        "地域別のサンプル集計とデータソース状態です。個別ユーザー情報は含みません。",
        {
          mode: snapshot.mode,
          generatedAt: snapshot.generatedAt,
          regions: snapshot.regions,
          sources: snapshot.sources,
        },
      );
    },
  );

  registerAppResource(
    server,
    "Spota Data Atlas",
    summaryResourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf8");
      return {
        contents: [
          {
            uri: summaryResourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                csp: {
                  connectDomains: [],
                  resourceDomains: [],
                  frameDomains: [],
                },
              },
            },
          },
        ],
      };
    },
  );

  return server;
}
