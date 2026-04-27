import type { IncomingMessage, ServerResponse } from "http";
import { URL } from "url";
import fs from "fs";
import { log } from "../logger.js";
import type { RunAllResult } from "../types.js";
import { isRequestAuthorized } from "./bearerAuth.js";
import { getApiToken, getWebhookUrl } from "./config.js";
import { writeOptionsCorsNoContent } from "./cors.js";
import {
  buildNeedsReplyItems,
  readLatestInboxResults,
  readLatestMentionResults,
  readStatusJsonPath,
} from "./artifactReader.js";
import { readJsonBody } from "./parseJsonBody.js";
import { sendError, sendOk } from "./jsonResponses.js";
import { postJsonWebhook } from "./webhookClient.js";
import { createNodeScriptRunner } from "./nodeScriptRunner.js";

export type RequestHandlerContext = {
  port: number;
  /** Directory of `server.ts` / `server.js` (for resolving `inbox.ts`, `register.js`, …). */
  serverDir: string;
};

/**
 * Main HTTP request handler: routing, auth, and delegates to artifacts / child processes.
 */
export function createRequestHandler(ctx: RequestHandlerContext) {
  const { port, serverDir } = ctx;
  const apiToken = getApiToken();
  const webhookUrl = getWebhookUrl();
  const scripts = createNodeScriptRunner(serverDir);

  return async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const u = new URL(req.url ?? "/", `http://localhost:${port}`);
    const route = u.pathname.replace(/\/$/, "") || "/";
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      writeOptionsCorsNoContent(res);
      return;
    }

    if (route !== "/health" && !isRequestAuthorized(req, apiToken)) {
      sendError(
        res,
        401,
        "Unauthorized — provide Bearer token in Authorization header"
      );
      return;
    }

    log.info(`${method} ${route}`);

    try {
      if (method === "GET" && route === "/health") {
        sendOk(res, {
          status: "ok",
          service: "linkedin-automation",
          port,
        });
        return;
      }

      if (method === "GET" && route === "/status") {
        const statusPath = readStatusJsonPath();
        if (!fs.existsSync(statusPath)) {
          sendError(res, 404, "No status file yet");
          return;
        }
        sendOk(res, JSON.parse(fs.readFileSync(statusPath, "utf-8")));
        return;
      }

      if (method === "GET" && route === "/inbox") {
        sendOk(res, readLatestInboxResults());
        return;
      }

      if (method === "GET" && route.startsWith("/inbox/")) {
        const profile = decodeURIComponent(route.slice(7));
        const results = readLatestInboxResults(profile);
        if (results.length === 0) {
          sendError(
            res,
            404,
            `No inbox data for profile '${profile}'`
          );
          return;
        }
        sendOk(res, results[0]);
        return;
      }

      if (method === "GET" && route === "/mentions") {
        sendOk(res, readLatestMentionResults());
        return;
      }

      if (method === "GET" && route.startsWith("/mentions/")) {
        const profile = decodeURIComponent(route.slice(10));
        const results = readLatestMentionResults(profile);
        if (results.length === 0) {
          sendError(
            res,
            404,
            `No mention data for profile '${profile}'`
          );
          return;
        }
        sendOk(res, results[0]);
        return;
      }

      if (method === "GET" && route === "/needs-reply") {
        sendOk(res, buildNeedsReplyItems());
        return;
      }

      if (method === "POST" && route === "/run/inbox") {
        const body = await readJsonBody(req);
        const profile = body.profile as string | undefined;
        log.info(
          `Triggering inbox scrape${profile ? ` for ${profile}` : " (all profiles)"}`
        );
        const results = scripts.runInboxScrape(profile);
        await postJsonWebhook(webhookUrl, {
          event: "inbox_scraped",
          profiles: results.map((r) => r.profile),
          timestamp: new Date().toISOString(),
        });
        sendOk(res, results);
        return;
      }

      if (method === "POST" && route === "/run/mentions") {
        const body = await readJsonBody(req);
        const profile = body.profile as string | undefined;
        log.info(
          `Triggering mention check${profile ? ` for ${profile}` : " (all profiles)"}`
        );
        const results = scripts.runMentionCheck(profile);
        await postJsonWebhook(webhookUrl, {
          event: "mentions_checked",
          total_new: results.reduce((s, r) => s + r.new_mention_count, 0),
          timestamp: new Date().toISOString(),
        });
        sendOk(res, results);
        return;
      }

      if (method === "POST" && route === "/run/all") {
        log.info("Triggering full run (inbox + mentions)");
        const inbox = scripts.runInboxScrape();
        const mentions = scripts.runMentionCheck();
        const payload: RunAllResult = {
          inbox,
          mentions,
          checked_at: new Date().toISOString(),
        };
        await postJsonWebhook(webhookUrl, {
          event: "full_run_complete",
          needs_reply_count: buildNeedsReplyItems().length,
          new_mention_count: mentions.reduce(
            (s, r) => s + r.new_mention_count,
            0
          ),
          timestamp: payload.checked_at,
        });
        sendOk(res, payload);
        return;
      }

      if (method === "POST" && route === "/reply") {
        const body = await readJsonBody(req);
        const { profile, conversation_id, text } = body as {
          profile?: string;
          conversation_id?: string;
          text?: string;
        };
        if (!profile || !conversation_id || !text) {
          sendError(res, 400, "Required: profile, conversation_id, text");
          return;
        }
        const r = scripts.runReply(profile, conversation_id, text);
        if (!r.ok) {
          sendError(
            res,
            500,
            `Reply failed: ${r.stderr.slice(0, 300)}`
          );
          return;
        }
        sendOk(res, { sent: true, profile, conversation_id });
        return;
      }

      if (method === "GET" && route === "/profile") {
        const linkedinUrl = u.searchParams.get("url");
        const profile = u.searchParams.get("profile") ?? "Default";
        if (!linkedinUrl) {
          sendError(res, 400, "Required query param: url");
          return;
        }
        const r = scripts.runProfileScrape(linkedinUrl, profile);
        if (!r.ok) {
          sendError(
            res,
            500,
            `Profile scrape failed: ${r.stderr.slice(0, 300)}`
          );
          return;
        }
        sendOk(res, r.data);
        return;
      }

      if (method === "GET" && route === "/webhook/test") {
        await postJsonWebhook(webhookUrl, {
          event: "test",
          message: "LinkedIn automation webhook test",
          timestamp: new Date().toISOString(),
        });
        sendOk(res, {
          fired: !!webhookUrl,
          url: webhookUrl || "(none configured)",
        });
        return;
      }

      sendError(res, 404, `Unknown route: ${method} ${route}`);
    } catch (e) {
      log.error(`Handler error: ${e}`);
      sendError(res, 500, String(e));
    }
  };
}
