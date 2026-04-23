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

import { chromium, type Page } from "playwright";
import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import {
  CHROME_EXECUTABLE,
  CHROME_USER_DATA,
  OUTPUT_DIR,
  CHROME_ARGS,
} from "./config.js";
import { log } from "./logger.js";
import type { Mention, MentionResult } from "./types.js";

const SEEN_STATE_FILE = path.join(OUTPUT_DIR, "linkedin_mentions_seen.json");
const MENTIONS_URL = "https://www.linkedin.com/notifications/?filter=mentions";

// ── Seen-ID state ─────────────────────────────────────────────────────────────

function loadSeenIds(): Set<string> {
  try {
    if (fs.existsSync(SEEN_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(SEEN_STATE_FILE, "utf-8")) as string[];
      return new Set(data);
    }
  } catch { /* corrupt state — start fresh */ }
  return new Set();
}

function saveSeenIds(seen: Set<string>): void {
  const arr = [...seen].slice(-2000); // cap at 2000 to avoid unbounded growth
  fs.writeFileSync(SEEN_STATE_FILE, JSON.stringify(arr, null, 2), "utf-8");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isLoggedIn(url: string): boolean {
  return !url.includes("/login") && !url.includes("/checkpoint") && !url.includes("/uas/");
}

function discoverProfiles(): string[] {
  const entries = fs.readdirSync(CHROME_USER_DATA, { withFileTypes: true });
  return entries
    .filter(
      (e) => e.isDirectory() && (e.name === "Default" || /^Profile \d+$/.test(e.name))
    )
    .map((e) => e.name)
    .sort();
}

// ── Raw mention shape from page.evaluate ─────────────────────────────────────

interface RawMention {
  cardIndex: string;
  headlineText: string;
  authorName: string;
  authorProfileUrl: string;
  postUrl: string;
  commentPreview: string;
  timeAgo: string;
  isUnread: boolean;
}

async function scrapeMentionCards(page: Page): Promise<RawMention[]> {
  return page.evaluate((): RawMention[] => {
    const articles = document.querySelectorAll<HTMLElement>("article.nt-card");
    const results: RawMention[] = [];

    articles.forEach((article) => {
      // Only process mention notifications
      const headlineEl = article.querySelector<HTMLElement>(".nt-card__headline");
      const headlineText = headlineEl?.innerText?.trim() ?? "";
      if (!headlineText.toLowerCase().includes("mentioned you")) return;

      // Unique ID — use data-nt-card-index (stable per page load positional)
      // Combined with the post URL to make it content-stable across runs
      const cardIndex = article.getAttribute("data-nt-card-index") ?? "";

      // Author: the profile image link in the left rail has data-view-name="notification-card-image"
      const authorLinkEl = article.querySelector<HTMLAnchorElement>(
        'a[data-view-name="notification-card-image"]'
      );
      const authorProfileUrl = authorLinkEl
        ? `https://www.linkedin.com${authorLinkEl.getAttribute("href") ?? ""}`.split("?")[0]
        : "";

      // Author name: first <strong> tag inside the headline span
      const firstStrong = headlineEl?.querySelector<HTMLElement>("strong");
      const authorName = firstStrong?.innerText?.trim() ?? "";

      // Post URL: the headline <a> href (the link to the feed post/comment)
      const headlineLink = article.querySelector<HTMLAnchorElement>("a.nt-card__headline");
      const rawHref = headlineLink?.getAttribute("href") ?? "";
      const postUrl = rawHref ? `https://www.linkedin.com${rawHref}` : "";

      // Comment preview text shown in the inline card below the headline
      const previewEl = article.querySelector<HTMLElement>(
        ".nt-card__text--2-line-large, .nt-card-content__body-text"
      );
      const commentPreview = previewEl?.innerText?.trim() ?? "";

      // Timestamp
      const timeAgo = article.querySelector<HTMLElement>(".nt-card__time-ago")?.innerText?.trim() ?? "";

      // Unread status
      const isUnread = article.classList.contains("nt-card--unread");

      results.push({
        cardIndex,
        headlineText,
        authorName,
        authorProfileUrl,
        postUrl,
        commentPreview,
        timeAgo,
        isUnread,
      });
    });

    return results;
  });
}

// ── Classify mention type from headline text ──────────────────────────────────

function classifyMentionType(headlineText: string): Mention["type"] {
  const lower = headlineText.toLowerCase();
  if (lower.includes("mentioned you in a comment")) return "comment_mention";
  if (lower.includes("post that mentioned you") || lower.includes("mentioned you in a post")) return "post_mention";
  return "comment_mention"; // safe default
}

// ── Per-profile scrape ────────────────────────────────────────────────────────

export async function scrapeMentions(profileName: string): Promise<MentionResult> {
  const result: MentionResult = {
    profile: profileName,
    account_name: "",
    scraped_at: new Date().toISOString(),
    status: "ok",
    mentions: [],
    new_mention_count: 0,
  };

  const seenIds = loadSeenIds();
  const updatedSeen = new Set(seenIds);

  try {
    const browser = await chromium.launchPersistentContext(CHROME_USER_DATA, {
      headless: true,
      executablePath: CHROME_EXECUTABLE,
      args: [...CHROME_ARGS, `--profile-directory=${profileName}`],
    });

    const page = browser.pages()[0] ?? (await browser.newPage());

    log.info(`[${profileName}] Navigating to mentions filter...`);
    await page.goto(MENTIONS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);

    if (!isLoggedIn(page.url())) {
      result.status = "not_logged_in";
      log.warning(`[${profileName}] Not logged in`);
      await browser.close();
      return result;
    }

    // Get account name
    try {
      const alt = await page.locator("img.global-nav__me-photo").first().getAttribute("alt", { timeout: 5000 });
      if (alt?.trim()) result.account_name = alt.trim();
    } catch { /* non-fatal */ }

    // Click "New notifications" pill if present — loads fresh mentions
    try {
      const newBtn = page.locator("button[aria-label='Load new notifications']").first();
      if (await newBtn.count() > 0) {
        await newBtn.click();
        await page.waitForTimeout(2000);
        log.info(`[${profileName}] Clicked 'Load new notifications'`);
      }
    } catch { /* not present — that's fine */ }

    // Wait for mention cards to appear
    try {
      await page.waitForSelector("article.nt-card", { timeout: 10000 });
    } catch {
      log.warning(`[${profileName}] No notification cards found on mentions page`);
      await page.screenshot({ path: `/tmp/linkedin_mentions_${profileName}_error.png` });
    }

    // Scroll to load more
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(700);
    }

    const raw = await scrapeMentionCards(page);
    log.info(`[${profileName}] Found ${raw.length} mention card(s)`);

    for (const r of raw) {
      // Stable ID = post URL (unique per post/comment), falls back to card index
      const stableId = r.postUrl || `${profileName}_card_${r.cardIndex}`;
      const isNew = !seenIds.has(stableId);
      updatedSeen.add(stableId);

      result.mentions.push({
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

    result.new_mention_count = result.mentions.filter((m) => m.is_new).length;
    saveSeenIds(updatedSeen);

    log.info(`[${profileName}] ${result.mentions.length} total, ${result.new_mention_count} new`);
    await browser.close();
  } catch (e) {
    log.error(`[${profileName}] Fatal error: ${e}`);
    result.status = "error";
    result.error = String(e);
  }

  return result;
}

// ── Write output JSON ─────────────────────────────────────────────────────────

export function writeMentionOutput(result: MentionResult): string {
  const safeName = result.profile.replace(/ /g, "");
  const ts = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  const outPath = path.join(OUTPUT_DIR, `linkedin_mentions_${safeName}_${ts}.json`);
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
    console.log(`  ${result.mentions.length} mentions | ${result.new_mention_count} new`);

    if (result.mentions.length > 0) {
      console.log(`\n  Mentions:`);
      for (const m of result.mentions) {
        const tag = m.is_new ? "[NEW]" : "[seen]";
        console.log(`    ${tag} ${m.author_name} — ${m.type}`);
        console.log(`      ${m.post_text}`);
        if (m.comment_text) console.log(`      Preview: ${m.comment_text.slice(0, 120)}`);
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

main().catch((e) => { console.error(e); process.exit(0); });
