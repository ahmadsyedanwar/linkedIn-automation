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
 * Endpoints:
 *   GET  /health                      — liveness check
 *   GET  /inbox                       — latest inbox results from /tmp
 *   GET  /inbox/:profile              — single profile inbox
 *   GET  /mentions                    — latest mention results from /tmp
 *   GET  /mentions/:profile           — single profile mentions
 *   GET  /status                      — latest linkedin_status.json
 *   POST /run/inbox                   — trigger live inbox scrape (blocks)
 *   POST /run/mentions                — trigger live mention check (blocks)
 *   POST /run/all                     — trigger inbox + mentions (blocks)
 *   POST /reply                       — send a reply to a conversation
 *   GET  /profile                     — scrape a LinkedIn profile bio
 *   GET  /needs-reply                 — all threads needing reply across all profiles
 *   GET  /webhook/test                — fire a test payload to configured webhook
 */

import http from "http";
import fs from "fs";
import path from "path";
import { URL } from "url";
import { scrapeMentions, writeMentionOutput } from "./mentionChecker.js";
import { OUTPUT_DIR } from "./config.js";
import { log } from "./logger.js";
import type {
  ApiResponse,
  InboxResult,
  MentionResult,
  RunAllResult,
  FileSummary,
  NeedsReplyItem,
} from "./types.js";

const PORT = parseInt(process.env.PORT ?? "9000", 10);
const API_TOKEN = process.env.LINKEDIN_API_TOKEN ?? "";
// Webhook to notify when new data is ready (optional)
const WEBHOOK_URL = process.env.LINKEDIN_WEBHOOK_URL ?? "";

// ── Auth middleware ───────────────────────────────────────────────────────────

function checkAuth(req: http.IncomingMessage): boolean {
  if (!API_TOKEN) return true; // no token configured — open (dev mode)
  const auth = req.headers["authorization"] ?? "";
  return auth === `Bearer ${API_TOKEN}`;
}

// ── Response helpers ──────────────────────────────────────────────────────────

function json<T>(res: http.ServerResponse, status: number, body: ApiResponse<T>): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  });
  res.end(payload);
}

function ok<T>(res: http.ServerResponse, data: T): void {
  json(res, 200, { ok: true, data, timestamp: new Date().toISOString() });
}

function err(res: http.ServerResponse, status: number, message: string): void {
  json(res, status, { ok: false, error: message, timestamp: new Date().toISOString() });
}

// ── File-system helpers ───────────────────────────────────────────────────────

function latestInboxFiles(): string[] {
  return fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.startsWith("linkedin_inbox_") && f.endsWith(".json") && !f.startsWith("linkedin_inbox_check"))
    .map((f) => path.join(OUTPUT_DIR, f))
    .filter((f) => fs.statSync(f).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function latestMentionFiles(): string[] {
  return fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.startsWith("linkedin_mentions_") && f.endsWith(".json"))
    .map((f) => path.join(OUTPUT_DIR, f))
    .filter((f) => fs.statSync(f).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function readLatestInbox(profileFilter?: string): InboxResult[] {
  const files = latestInboxFiles();
  // One file per profile per run — de-duplicate by picking the newest per profile
  const seen = new Map<string, InboxResult>();
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(f, "utf-8")) as InboxResult;
      const profile = data.profile ?? "";
      if (profileFilter && profile.toLowerCase() !== profileFilter.toLowerCase()) continue;
      if (!seen.has(profile)) seen.set(profile, data);
    } catch { /* skip corrupt */ }
  }
  return [...seen.values()];
}

function readLatestMentions(profileFilter?: string): MentionResult[] {
  const files = latestMentionFiles();
  const seen = new Map<string, MentionResult>();
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(f, "utf-8")) as MentionResult;
      const profile = data.profile ?? "";
      if (profileFilter && profile.toLowerCase() !== profileFilter.toLowerCase()) continue;
      if (!seen.has(profile)) seen.set(profile, data);
    } catch { /* skip corrupt */ }
  }
  return [...seen.values()];
}

function needsReply(): NeedsReplyItem[] {
  const inboxResults = readLatestInbox();
  const items: NeedsReplyItem[] = [];
  for (const r of inboxResults) {
    for (const conv of r.conversations ?? []) {
      if (!conv.needs_reply) continue;
      let lastIncoming = "";
      for (const msg of [...(conv.messages ?? [])].reverse()) {
        if (msg.direction === "incoming") { lastIncoming = msg.body; break; }
      }
      items.push({
        inbox_json: "",
        profile_key: r.profile,
        account_name: r.account_name,
        conversation_id: conv.conversation_id,
        connection_name: conv.sender_name,
        last_incoming_message: lastIncoming,
        messages: conv.messages,
        sender_profile_url: conv.sender_profile_url,
        timestamp: conv.timestamp,
      });
    }
  }
  return items;
}

// ── Webhook notifier ──────────────────────────────────────────────────────────

async function fireWebhook(payload: unknown): Promise<void> {
  if (!WEBHOOK_URL) return;
  try {
    const u = new URL(WEBHOOK_URL);
    const body = JSON.stringify(payload);
    const options: http.RequestOptions = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    await new Promise<void>((resolve) => {
      const req = http.request(options, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", (e) => {
        log.warning(`Webhook fire failed: ${e.message}`);
        resolve();
      });
      req.write(body);
      req.end();
    });
    log.info(`Webhook fired to ${WEBHOOK_URL}`);
  } catch (e) {
    log.warning(`Webhook error: ${e}`);
  }
}

// ── Live scrape runners ───────────────────────────────────────────────────────

async function runInboxScrape(profile?: string): Promise<InboxResult[]> {
  // Dynamically import to avoid circular deps and allow lazy loading
  const { default: { run } } = await import("./inbox.js") as { default: { run: (args: { profile?: string; reply: boolean }) => Promise<InboxResult[]> } };
  return run({ profile, reply: false });
}

// We use a child-process approach for inbox since it manages its own browser
// contexts and profile copies — safer than importing directly
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function spawnInbox(profile?: string): InboxResult[] {
  const args = ["--import", path.resolve(__dirname, "../register.js"),
    path.resolve(__dirname, "inbox.ts")];
  if (profile) args.push("--profile", profile);
  const proc = spawnSync("node", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 300_000,
    env: { ...process.env },
  });
  if (proc.status !== 0) {
    log.error(`inbox scrape exited ${proc.status}: ${proc.stderr?.slice(0, 500)}`);
  }
  // Read the freshly-written files
  return readLatestInbox(profile);
}

function spawnMentions(profile?: string): MentionResult[] {
  const args = ["--import", path.resolve(__dirname, "../register.js"),
    path.resolve(__dirname, "mentionChecker.ts")];
  if (profile) args.push("--profile", profile);
  const proc = spawnSync("node", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 300_000,
    env: { ...process.env },
  });
  if (proc.status !== 0) {
    log.error(`mention check exited ${proc.status}: ${proc.stderr?.slice(0, 500)}`);
  }
  return readLatestMentions(profile);
}

// ── Body parser ───────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { resolve({}); }
    });
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

async function handler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const u = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const route = u.pathname.replace(/\/$/, "") || "/";
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
    res.end();
    return;
  }

  // Auth check (skip /health)
  if (route !== "/health" && !checkAuth(req)) {
    err(res, 401, "Unauthorized — provide Bearer token in Authorization header");
    return;
  }

  log.info(`${method} ${route}`);

  try {
    // ── GET /health ──────────────────────────────────────────────────────
    if (method === "GET" && route === "/health") {
      ok(res, { status: "ok", service: "linkedin-automation", port: PORT });
      return;
    }

    // ── GET /status ──────────────────────────────────────────────────────
    if (method === "GET" && route === "/status") {
      const statusPath = path.join(OUTPUT_DIR, "linkedin_status.json");
      if (!fs.existsSync(statusPath)) { err(res, 404, "No status file yet"); return; }
      ok(res, JSON.parse(fs.readFileSync(statusPath, "utf-8")));
      return;
    }

    // ── GET /inbox ───────────────────────────────────────────────────────
    if (method === "GET" && route === "/inbox") {
      ok(res, readLatestInbox());
      return;
    }

    // ── GET /inbox/:profile ──────────────────────────────────────────────
    if (method === "GET" && route.startsWith("/inbox/")) {
      const profile = decodeURIComponent(route.slice(7));
      const results = readLatestInbox(profile);
      if (results.length === 0) { err(res, 404, `No inbox data for profile '${profile}'`); return; }
      ok(res, results[0]);
      return;
    }

    // ── GET /mentions ────────────────────────────────────────────────────
    if (method === "GET" && route === "/mentions") {
      ok(res, readLatestMentions());
      return;
    }

    // ── GET /mentions/:profile ───────────────────────────────────────────
    if (method === "GET" && route.startsWith("/mentions/")) {
      const profile = decodeURIComponent(route.slice(10));
      const results = readLatestMentions(profile);
      if (results.length === 0) { err(res, 404, `No mention data for profile '${profile}'`); return; }
      ok(res, results[0]);
      return;
    }

    // ── GET /needs-reply ─────────────────────────────────────────────────
    if (method === "GET" && route === "/needs-reply") {
      ok(res, needsReply());
      return;
    }

    // ── POST /run/inbox ──────────────────────────────────────────────────
    if (method === "POST" && route === "/run/inbox") {
      const body = await readBody(req);
      const profile = body.profile as string | undefined;
      log.info(`Triggering inbox scrape${profile ? ` for ${profile}` : " (all profiles)"}`);
      const results = spawnInbox(profile);
      await fireWebhook({ event: "inbox_scraped", profiles: results.map((r) => r.profile), timestamp: new Date().toISOString() });
      ok(res, results);
      return;
    }

    // ── POST /run/mentions ───────────────────────────────────────────────
    if (method === "POST" && route === "/run/mentions") {
      const body = await readBody(req);
      const profile = body.profile as string | undefined;
      log.info(`Triggering mention check${profile ? ` for ${profile}` : " (all profiles)"}`);
      const results = spawnMentions(profile);
      await fireWebhook({ event: "mentions_checked", total_new: results.reduce((s, r) => s + r.new_mention_count, 0), timestamp: new Date().toISOString() });
      ok(res, results);
      return;
    }

    // ── POST /run/all ────────────────────────────────────────────────────
    if (method === "POST" && route === "/run/all") {
      log.info("Triggering full run (inbox + mentions)");
      const inbox = spawnInbox();
      const mentions = spawnMentions();
      const payload: RunAllResult = {
        inbox,
        mentions,
        checked_at: new Date().toISOString(),
      };
      await fireWebhook({
        event: "full_run_complete",
        needs_reply_count: needsReply().length,
        new_mention_count: mentions.reduce((s, r) => s + r.new_mention_count, 0),
        timestamp: payload.checked_at,
      });
      ok(res, payload);
      return;
    }

    // ── POST /reply ──────────────────────────────────────────────────────
    if (method === "POST" && route === "/reply") {
      const body = await readBody(req);
      const { profile, conversation_id, text } = body as {
        profile?: string;
        conversation_id?: string;
        text?: string;
      };
      if (!profile || !conversation_id || !text) {
        err(res, 400, "Required: profile, conversation_id, text");
        return;
      }
      const args = ["--import", path.resolve(__dirname, "../register.js"),
        path.resolve(__dirname, "inbox.ts"),
        "--profile", profile,
        "--reply",
        "--conversation-id", conversation_id,
        "--text", text];
      const proc = spawnSync("node", args, {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
        timeout: 60_000,
        env: { ...process.env },
      });
      if (proc.status !== 0) {
        err(res, 500, `Reply failed: ${proc.stderr?.slice(0, 300)}`);
        return;
      }
      ok(res, { sent: true, profile, conversation_id });
      return;
    }

    // ── GET /profile ─────────────────────────────────────────────────────
    if (method === "GET" && route === "/profile") {
      const linkedinUrl = u.searchParams.get("url");
      const profile = u.searchParams.get("profile") ?? "Default";
      if (!linkedinUrl) { err(res, 400, "Required query param: url"); return; }
      const args = ["--import", path.resolve(__dirname, "../register.js"),
        path.resolve(__dirname, "profileScraper.ts"),
        "--url", linkedinUrl,
        "--profile", profile];
      const proc = spawnSync("node", args, {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
        timeout: 120_000,
        env: { ...process.env },
      });
      // Find freshest bio JSON
      const bioFiles = fs.readdirSync(OUTPUT_DIR)
        .filter((f) => f.startsWith("linkedin_bio_") && f.endsWith(".json"))
        .map((f) => path.join(OUTPUT_DIR, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (bioFiles.length === 0 || proc.status !== 0) {
        err(res, 500, `Profile scrape failed: ${proc.stderr?.slice(0, 300)}`);
        return;
      }
      ok(res, JSON.parse(fs.readFileSync(bioFiles[0], "utf-8")));
      return;
    }

    // ── GET /webhook/test ────────────────────────────────────────────────
    if (method === "GET" && route === "/webhook/test") {
      await fireWebhook({ event: "test", message: "LinkedIn automation webhook test", timestamp: new Date().toISOString() });
      ok(res, { fired: !!WEBHOOK_URL, url: WEBHOOK_URL || "(none configured)" });
      return;
    }

    err(res, 404, `Unknown route: ${method} ${route}`);
  } catch (e) {
    log.error(`Handler error: ${e}`);
    err(res, 500, String(e));
  }
}

// ── Start server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  handler(req, res).catch((e) => {
    log.error(`Unhandled: ${e}`);
    res.writeHead(500);
    res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
  });
});

server.listen(PORT, "0.0.0.0", () => {
  log.info(`LinkedIn automation API server listening on port ${PORT}`);
  log.info(`Auth: ${API_TOKEN ? "token required" : "OPEN (set LINKEDIN_API_TOKEN to secure)"}`);
  log.info(`Webhook: ${WEBHOOK_URL || "(none — set LINKEDIN_WEBHOOK_URL to enable)"}`);
  log.info(`Endpoints: GET /health /inbox /mentions /needs-reply /status /profile`);
  log.info(`           POST /run/inbox /run/mentions /run/all /reply`);
});

server.on("error", (e) => {
  log.error(`Server error: ${e.message}`);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { server.close(() => process.exit(0)); });
