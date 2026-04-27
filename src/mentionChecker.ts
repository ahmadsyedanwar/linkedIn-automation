#!/usr/bin/env node
/**
 * mentionChecker.ts — Scrape LinkedIn notifications for @mentions.
 *
 * Navigates to /notifications/?filter=mentions, clicks "Load new notifications"
 * if present, then extracts every mention card (article.nt-card) whose headline
 * contains "mentioned you". Tracks seen IDs via a state file so only genuinely
 * new mentions are flagged `is_new: true`.
 *
 * Usage:
 *   node --import ./register.js src/mentionChecker.ts --profile Default
 *   node --import ./register.js src/mentionChecker.ts   # all profiles
 */

import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import { CHROME_USER_DATA, OUTPUT_DIR } from "./config.js";
import { log } from "./logger.js";
import {
  getOrCreateFirstPage,
  launchChromiumForProfile,
  MentionsPage,
} from "./pageObjects/index.js";
import type { Mention, MentionResult, RawMention } from "./types.js";

const SEEN_STATE_FILE = path.join(OUTPUT_DIR, "linkedin_mentions_seen.json");

// ── Seen-ID state ─────────────────────────────────────────────────────────────

function loadSeenIds(): Set<string> {
  try {
    if (fs.existsSync(SEEN_STATE_FILE)) {
      const data = JSON.parse(
        fs.readFileSync(SEEN_STATE_FILE, "utf-8")
      ) as string[];
      return new Set(data);
    }
  } catch {
    /* corrupt state — start fresh */
  }
  return new Set();
}

function saveSeenIds(seen: Set<string>): void {
  const arr = [...seen].slice(-2000);
  fs.writeFileSync(SEEN_STATE_FILE, JSON.stringify(arr, null, 2), "utf-8");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function discoverProfiles(): string[] {
  const entries = fs.readdirSync(CHROME_USER_DATA, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isDirectory() &&
        (e.name === "Default" || /^Profile \d+$/.test(e.name))
    )
    .map((e) => e.name)
    .sort();
}

function classifyMentionType(headlineText: string): Mention["type"] {
  const lower = headlineText.toLowerCase();
  if (lower.includes("mentioned you in a comment")) return "comment_mention";
  if (
    lower.includes("post that mentioned you") ||
    lower.includes("mentioned you in a post")
  ) {
    return "post_mention";
  }
  return "comment_mention";
}

function mapRawToMentions(
  profileName: string,
  raw: RawMention[],
  seenIds: Set<string>
): { mentions: Mention[]; updatedSeen: Set<string> } {
  const updatedSeen = new Set(seenIds);
  const mentions: Mention[] = [];
  for (const r of raw) {
    const stableId = r.postUrl || `${profileName}_card_${r.cardIndex}`;
    const isNew = !seenIds.has(stableId);
    updatedSeen.add(stableId);
    mentions.push({
      mention_id: stableId,
      type: classifyMentionType(r.headlineText),
      author_name: r.authorName,
      author_profile_url: r.authorProfileUrl,
      post_text: r.headlineText,
      comment_text: r.commentPreview,
      post_url: r.postUrl,
      timestamp: r.timeAgo,
      is_new: isNew,
    });
  }
  return { mentions, updatedSeen };
}

// ── Per-profile scrape (page objects + AAA) ────────────────────────────────────────────

export async function scrapeMentions(profileName: string): Promise<MentionResult> {
  const result: MentionResult = {
    profile: profileName,
    account_name: "",
    scraped_at: new Date().toISOString(),
    status: "ok",
    mentions: [],
    new_mention_count: 0,
  };

  // —— Arrange
  const seenIds = loadSeenIds();
  let browser: Awaited<ReturnType<typeof launchChromiumForProfile>> | null =
    null;

  try {
    // —— Act
    browser = await launchChromiumForProfile(profileName);
    const page = await getOrCreateFirstPage(browser);
    const mentions = new MentionsPage(page);

    await mentions.openMentionsFilter(profileName);
    if (!mentions.isLoggedIn()) {
      result.status = "not_logged_in";
      log.warning(`[${profileName}] Not logged in`);
      return result;
    }

    const acc = await mentions.getAccountNameFromNav();
    if (acc && acc !== "Unknown") result.account_name = acc;

    await mentions.clickLoadNewNotificationsIfPresent(profileName);
    await mentions.waitForMentionCardsOrCaptureError(profileName);
    await mentions.scrollToLoadMoreNotifications();
    const raw = await mentions.readMentionCardDom();
    log.info(`[${profileName}] Found ${raw.length} mention card(s)`);

    // —— Assert (map + state)
    const { mentions: list, updatedSeen } = mapRawToMentions(
      profileName,
      raw,
      seenIds
    );
    result.mentions = list;
    result.new_mention_count = result.mentions.filter((m) => m.is_new).length;
    saveSeenIds(updatedSeen);

    log.info(
      `[${profileName}] ${result.mentions.length} total, ${result.new_mention_count} new`
    );
  } catch (e) {
    log.error(`[${profileName}] Fatal error: ${e}`);
    result.status = "error";
    result.error = String(e);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  }
  return result;
}

// ── Write output JSON ─────────────────────────────────────────────────────────

export function writeMentionOutput(result: MentionResult): string {
  const safeName = result.profile.replace(/ /g, "");
  const ts = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  const outPath = path.join(
    OUTPUT_DIR,
    `linkedin_mentions_${safeName}_${ts}.json`
  );
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");
  return outPath;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    options: { profile: { type: "string" } },
    allowPositionals: false,
    strict: false,
  });

  const profiles = values.profile
    ? [values.profile as string]
    : discoverProfiles();

  log.info(`Checking mentions for profiles: ${profiles.join(", ")}`);

  for (let i = 0; i < profiles.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 3000));
    const result = await scrapeMentions(profiles[i]);
    const outPath = writeMentionOutput(result);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`[${result.profile}] ${result.account_name}`);
    console.log(
      `  ${result.mentions.length} mentions | ${result.new_mention_count} new`
    );

    if (result.mentions.length > 0) {
      console.log(`\n  Mentions:`);
      for (const m of result.mentions) {
        const tag = m.is_new ? "[NEW]" : "[seen]";
        console.log(`    ${tag} ${m.author_name} — ${m.type}`);
        console.log(`      ${m.post_text}`);
        if (m.comment_text)
          console.log(`      Preview: ${m.comment_text.slice(0, 120)}`);
        console.log(`      ${m.post_url}`);
        console.log(`      ${m.timestamp}`);
        console.log();
      }
    } else {
      console.log(`  No mentions found.`);
    }
    console.log(`  Output: ${outPath}`);
    console.log("=".repeat(60));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(0);
});
