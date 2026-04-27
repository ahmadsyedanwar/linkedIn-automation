import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { log } from "../logger.js";
import {
  readFreshestBioJsonPath,
  readLatestInboxResults,
  readLatestMentionResults,
} from "./artifactReader.js";
import type { InboxResult, MentionResult } from "../types.js";

const INBOX_TIMEOUT_MS = 300_000;
const MENTION_TIMEOUT_MS = 300_000;
const REPLY_TIMEOUT_MS = 60_000;
const PROFILE_TIMEOUT_MS = 120_000;

function nodeCmd(
  serverDir: string,
  scriptRelative: string,
  extraArgs: string[],
  timeout: number
): { status: number | null; stderr: string } {
  const register = path.resolve(serverDir, "../register.js");
  const scriptPath = path.resolve(serverDir, scriptRelative);
  const args = ["--import", register, scriptPath, ...extraArgs];
  const proc = spawnSync("node", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout,
    env: { ...process.env },
  });
  return { status: proc.status, stderr: proc.stderr ?? "" };
}

/**
 * Spawns the same `node --import register.js src/*.ts` flow the CLI uses.
 * `serverDir` is the directory containing `server.ts` (e.g. `src` or `dist`).
 */
export function createNodeScriptRunner(serverDir: string) {
  return {
    runInboxScrape(profile?: string): InboxResult[] {
      const extra = profile ? ["--profile", profile] : [];
      const { status, stderr } = nodeCmd(
        serverDir,
        "inbox.ts",
        extra,
        INBOX_TIMEOUT_MS
      );
      if (status !== 0) {
        log.error(
          `inbox scrape exited ${status}: ${stderr.slice(0, 500)}`
        );
      }
      return readLatestInboxResults(profile);
    },

    runMentionCheck(profile?: string): MentionResult[] {
      const extra = profile ? ["--profile", profile] : [];
      const { status, stderr } = nodeCmd(
        serverDir,
        "mentionChecker.ts",
        extra,
        MENTION_TIMEOUT_MS
      );
      if (status !== 0) {
        log.error(
          `mention check exited ${status}: ${stderr.slice(0, 500)}`
        );
      }
      return readLatestMentionResults(profile);
    },

    runReply(
      profile: string,
      conversationId: string,
      text: string
    ): { ok: true } | { ok: false; stderr: string } {
      const { status, stderr } = nodeCmd(
        serverDir,
        "inbox.ts",
        [
          "--profile",
          profile,
          "--reply",
          "--conversation-id",
          conversationId,
          "--text",
          text,
        ],
        REPLY_TIMEOUT_MS
      );
      if (status !== 0) {
        return { ok: false, stderr };
      }
      return { ok: true };
    },

    runProfileScrape(
      linkedinUrl: string,
      profile: string
    ): { ok: true; data: unknown } | { ok: false; stderr: string } {
      const { status, stderr } = nodeCmd(
        serverDir,
        "profileScraper.ts",
        ["--url", linkedinUrl, "--profile", profile],
        PROFILE_TIMEOUT_MS
      );
      const bioPath = readFreshestBioJsonPath();
      if (status !== 0 || !bioPath) {
        return {
          ok: false,
          stderr: stderr.slice(0, 300) || "No bio JSON written",
        };
      }
      return {
        ok: true,
        data: JSON.parse(fs.readFileSync(bioPath, "utf-8")) as unknown,
      };
    },
  };
}
