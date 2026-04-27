#!/usr/bin/env node
/**
 * server.ts — HTTP API server for LinkedIn automation results.
 *
 * Exposes scraped data on a local port so Jenkins, OpenClaw webhooks,
 * or Claude remote functions can consume results without running the
 * browser themselves.
 *
 * Port: 9000 (set via PORT env var)
 * Auth: Bearer token via LINKEDIN_API_TOKEN env var (required in production)
 *
 * Routing and helpers live under `src/httpServer/`. This file only boots the process.
 *
 * Endpoints:
 *   GET  /health, /status, /inbox, /inbox/:profile, /mentions, /mentions/:profile
 *   GET  /needs-reply, /profile?url=…&profile=…, /webhook/test
 *   POST /run/inbox, /run/mentions, /run/all, /reply
 */

import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { getServerPort, getApiToken, getWebhookUrl } from "./httpServer/config.js";
import { createRequestHandler } from "./httpServer/handleRequest.js";
import { log } from "./logger.js";

const port = getServerPort();
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const handleRequest = createRequestHandler({ port, serverDir });

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    log.error(`Unhandled: ${e}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
  });
});

server.listen(port, "0.0.0.0", () => {
  const token = getApiToken();
  const hook = getWebhookUrl();
  log.info(`LinkedIn automation API server listening on port ${port}`);
  log.info(
    `Auth: ${token ? "token required" : "OPEN (set LINKEDIN_API_TOKEN to secure)"}`
  );
  log.info(
    `Webhook: ${hook || "(none — set LINKEDIN_WEBHOOK_URL to enable)"}`
  );
  log.info(`Endpoints: GET /health /inbox /mentions /needs-reply /status /profile`);
  log.info(`           POST /run/inbox /run/mentions /run/all /reply`);
});

server.on("error", (e) => {
  log.error(`Server error: ${(e as Error).message}`);
  process.exit(1);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
