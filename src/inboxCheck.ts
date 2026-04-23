#!/usr/bin/env node
/**
 * inboxCheck.ts — Run inbox scraper and report threads that need a reply.
 *
 * Usage:
 *   npx ts-node src/inboxCheck.ts               # run scraper + analyze
 *   npx ts-node src/inboxCheck.ts --analyze-only # analyze existing /tmp files only
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type {
  InboxResult,
  NeedsReplyItem,
  FileSummary,
  InboxCheckSummary,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const INBOX_SCRIPT = path.resolve(__dirname, "inbox.ts");
const TMP_GLOB_DIR = "/tmp";
const STATE_FILE = path.resolve(__dirname, "../output/linkedin_inbox_check_latest.json");

function newestInboxFiles(): string[] {
  const files = fs
    .readdirSync(TMP_GLOB_DIR)
    .filter((f) => f.startsWith("linkedin_inbox_") && f.endsWith(".json"))
    .map((f) => path.join(TMP_GLOB_DIR, f))
    .filter((f) => fs.statSync(f).isFile());
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files;
}

function extractNeedsReply(filePath: string): FileSummary {
  const data: InboxResult = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const items: NeedsReplyItem[] = [];

  for (const conv of data.conversations ?? []) {
    if (!conv.needs_reply) continue;
    let lastIncoming = "";
    for (const msg of [...(conv.messages ?? [])].reverse()) {
      if (msg.direction === "incoming") {
        lastIncoming = msg.body ?? "";
        break;
      }
    }
    items.push({
      inbox_json: filePath,
      profile_key: data.profile ?? "",
      account_name: data.account_name ?? "",
      conversation_id: conv.conversation_id ?? "",
      connection_name: conv.sender_name ?? "",
      last_incoming_message: lastIncoming,
      messages: conv.messages ?? [],
      sender_profile_url: conv.sender_profile_url ?? "",
      timestamp: conv.timestamp ?? "",
    });
  }

  return {
    source_file: filePath,
    profile: data.profile ?? "",
    account_name: data.account_name ?? "",
    status: data.status ?? "",
    needs_reply: items,
  };
}

function printReport(summary: InboxCheckSummary): void {
  console.log(`LinkedIn inbox check — ${summary.checked_at}`);
  console.log(`Inbox JSON files analyzed: ${summary.files.length}`);
  console.log();

  let total = 0;
  for (const fileSummary of summary.results) {
    console.log(`FILE: ${fileSummary.source_file}`);
    console.log(
      `PROFILE: ${fileSummary.profile} | ACCOUNT: ${fileSummary.account_name} | STATUS: ${fileSummary.status}`
    );
    if (fileSummary.needs_reply.length === 0) {
      console.log("No threads need reply in this file.");
      console.log();
      continue;
    }
    for (const [idx, item] of fileSummary.needs_reply.entries()) {
      total++;
      console.log(`[${idx + 1}] Connection name: ${item.connection_name}`);
      console.log(`Conversation ID: ${item.conversation_id}`);
      console.log(`Last incoming message: ${item.last_incoming_message}`);
      console.log("Full conversation history:");
      for (const msg of item.messages) {
        const sender = msg.sender_name || msg.direction || "unknown";
        const body = (msg.body ?? "").replace(/\n/g, " ").trim();
        const ts = msg.timestamp ?? "";
        console.log(`- [${msg.direction ?? "unknown"}] ${sender} | ${ts} | ${body}`);
      }
      console.log();
    }
  }
  console.log(`Total threads needing reply: ${total}`);
}

function main(): void {
  const analyzeOnly = process.argv.includes("--analyze-only");

  if (!analyzeOnly) {
    const result = spawnSync("node", ["--loader", "ts-node/esm", INBOX_SCRIPT], {
      stdio: "inherit",
      encoding: "utf-8",
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }

  const files = newestInboxFiles();
  const results = files.map(extractNeedsReply);

  const summary: InboxCheckSummary = {
    checked_at: new Date().toISOString(),
    files,
    results,
  };

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(summary, null, 2), "utf-8");

  printReport(summary);
}

main();
