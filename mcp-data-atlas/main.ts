import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { json, type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "./server.js";

const MAX_ACTIVE_REQUESTS = 4;
const MAX_REQUESTS_PER_MINUTE = 30;
let activeRequests = 0;
const requestTimes: number[] = [];

function bearerMatches(req: Request): boolean {
  const expected = process.env.SPOTA_ATLAS_OPERATOR_TOKEN?.trim();
  if (!expected) return false;
  const header = req.header("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7), "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
}

function allowedOrigin(req: Request, res: Response): boolean {
  const origin = req.header("origin");
  if (!origin) {
    if (process.env.SPOTA_ATLAS_ALLOW_ORIGINLESS_HTTP !== "1") {
      res.status(403).json({ error: "origin_required" });
      return false;
    }
    return true;
  }
  const allowed = process.env.SPOTA_ATLAS_ALLOWED_ORIGIN?.trim();
  if (!allowed || origin !== allowed) {
    res.status(403).json({ error: "origin_not_allowed" });
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
  res.setHeader("Vary", "Origin");
  return true;
}

function withinRateLimit(): boolean {
  const now = Date.now();
  while (requestTimes[0] !== undefined && requestTimes[0] <= now - 60_000) requestTimes.shift();
  if (requestTimes.length >= MAX_REQUESTS_PER_MINUTE) return false;
  requestTimes.push(now);
  return true;
}

function validateLoopbackHost(req: Request, res: Response, next: NextFunction) {
  const hostHeader = req.header("host");
  if (!hostHeader) return res.status(403).json({ error: "host_required" });
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return res.status(403).json({ error: "invalid_host" });
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
    return res.status(403).json({ error: "loopback_only" });
  }
  return next();
}

export async function startStreamableHttpServer(create: () => McpServer): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("invalid_port");
  const operatorToken = process.env.SPOTA_ATLAS_OPERATOR_TOKEN?.trim() ?? "";
  if (Buffer.byteLength(operatorToken, "utf8") < 32) {
    throw new Error("SPOTA_ATLAS_OPERATOR_TOKEN is required for HTTP mode");
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(json({ limit: "64kb", strict: true }));
  app.use(validateLoopbackHost);
  app.use((req, res, next) => {
    if (req.method === "OPTIONS") {
      if (!allowedOrigin(req, res)) return;
      return res.sendStatus(204);
    }
    return next();
  });
  app.use((req, res, next) => {
    if (req.path !== "/mcp") return next();
    if (!allowedOrigin(req, res)) return;
    if (!bearerMatches(req)) {
      console.error(JSON.stringify({ event: "mcp_http_request", decision: "deny", reason: "auth" }));
      return res.status(401).json({ error: "operator_auth_required" });
    }
    if (!withinRateLimit()) return res.status(429).json({ error: "rate_limit" });
    if (activeRequests >= MAX_ACTIVE_REQUESTS) return res.status(429).json({ error: "concurrency_limit" });
    activeRequests += 1;
    const startedAt = Date.now();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeRequests = Math.max(0, activeRequests - 1);
      console.error(JSON.stringify({
        event: "mcp_http_request",
        decision: "allow",
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      }));
    };
    res.once("finish", release);
    res.once("close", release);
    return next();
  });

  app.all("/mcp", async (req: Request, res: Response) => {
    const server = create();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : 400;
    const safeStatus = status === 413 ? 413 : 400;
    console.error(JSON.stringify({ event: "mcp_http_parse_error", decision: "deny", status: safeStatus }));
    return res.status(safeStatus).json({ error: safeStatus === 413 ? "request_too_large" : "invalid_request" });
  });

  const httpServer = app.listen(port, "127.0.0.1", () => {
    console.error(`Spota Data Atlas MCP listening on loopback port ${port}`);
  });
  const shutdown = () => httpServer.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export async function startStdioServer(create: () => McpServer): Promise<void> {
  await create().connect(new StdioServerTransport());
}

if (process.argv.includes("--stdio")) {
  startStdioServer(createServer).catch(() => process.exit(1));
} else {
  startStreamableHttpServer(createServer).catch(() => process.exit(1));
}
