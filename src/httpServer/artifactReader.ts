import fs from "fs";
import path from "path";
import { outputDir } from "./config.js";
import type {
  InboxResult,
  MentionResult,
  NeedsReplyItem,
} from "../types.js";

function mtimeDesc(paths: string[]): void {
  paths.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function latestInboxFilePaths(): string[] {
  const files = fs
    .readdirSync(outputDir)
    .filter(
      (f) =>
        f.startsWith("linkedin_inbox_") &&
        f.endsWith(".json") &&
        !f.startsWith("linkedin_inbox_check")
    )
    .map((f) => path.join(outputDir, f))
    .filter((f) => fs.statSync(f).isFile());
  mtimeDesc(files);
  return files;
}

function latestMentionFilePaths(): string[] {
  const files = fs
    .readdirSync(outputDir)
    .filter(
      (f) => f.startsWith("linkedin_mentions_") && f.endsWith(".json")
    )
    .map((f) => path.join(outputDir, f))
    .filter((f) => fs.statSync(f).isFile());
  mtimeDesc(files);
  return files;
}

/**
 * Newest file per profile key (first time we see a profile in mtime order wins = newest per profile).
 */
export function readLatestInboxResults(
  profileFilter?: string
): InboxResult[] {
  const seen = new Map<string, InboxResult>();
  for (const f of latestInboxFilePaths()) {
    try {
      const data = JSON.parse(fs.readFileSync(f, "utf-8")) as InboxResult;
      const profile = data.profile ?? "";
      if (
        profileFilter &&
        profile.toLowerCase() !== profileFilter.toLowerCase()
      ) {
        continue;
      }
      if (!seen.has(profile)) seen.set(profile, data);
    } catch {
      /* skip corrupt */
    }
  }
  return [...seen.values()];
}

export function readLatestMentionResults(
  profileFilter?: string
): MentionResult[] {
  const seen = new Map<string, MentionResult>();
  for (const f of latestMentionFilePaths()) {
    try {
      const data = JSON.parse(fs.readFileSync(f, "utf-8")) as MentionResult;
      const profile = data.profile ?? "";
      if (
        profileFilter &&
        profile.toLowerCase() !== profileFilter.toLowerCase()
      ) {
        continue;
      }
      if (!seen.has(profile)) seen.set(profile, data);
    } catch {
      /* skip corrupt */
    }
  }
  return [...seen.values()];
}

export function buildNeedsReplyItems(): NeedsReplyItem[] {
  const inboxResults = readLatestInboxResults();
  const items: NeedsReplyItem[] = [];
  for (const r of inboxResults) {
    for (const conv of r.conversations ?? []) {
      if (!conv.needs_reply) continue;
      let lastIncoming = "";
      for (const msg of [...(conv.messages ?? [])].reverse()) {
        if (msg.direction === "incoming") {
          lastIncoming = msg.body;
          break;
        }
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

export function readStatusJsonPath(): string {
  return path.join(outputDir, "linkedin_status.json");
}

export function readFreshestBioJsonPath(): string | null {
  const bioFiles = fs
    .readdirSync(outputDir)
    .filter((f) => f.startsWith("linkedin_bio_") && f.endsWith(".json"))
    .map((f) => path.join(outputDir, f));
  if (bioFiles.length === 0) return null;
  mtimeDesc(bioFiles);
  return bioFiles[0];
}
