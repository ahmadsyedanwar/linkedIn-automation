#!/usr/bin/env node
/**
 * inbox.ts — Multi-profile LinkedIn inbox reader + reply tool using Playwright.
 *
 * Usage:
 *   npx ts-node src/inbox.ts                          # scrape all profiles
 *   npx ts-node src/inbox.ts --profile Default        # scrape one profile
 *   npx ts-node src/inbox.ts --profile Default --reply --conversation-id THREAD_ID --text "Hello!"
 */

import { chromium, type Page } from "playwright";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { parseArgs } from "util";
import {
  CHROME_EXECUTABLE,
  CHROME_USER_DATA,
  TMP_PROFILE_BASE,
  OUTPUT_DIR,
  CONVERSATIONS_TO_FETCH,
  MESSAGES_PER_CONV,
  CHROME_ARGS,
} from "./config.js";
import { log } from "./logger.js";
import type {
  Conversation,
  InboxResult,
  Message,
  RawMessageEntry,
  ReplyArgs,
  StatusMap,
} from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function discoverProfiles(): string[] {
  const entries = fs.readdirSync(CHROME_USER_DATA, { withFileTypes: true });
  const profiles = entries
    .filter(
      (e) =>
        e.isDirectory() &&
        (e.name === "Default" || /^Profile \d+$/.test(e.name))
    )
    .map((e) => e.name);
  return profiles.sort();
}

function copyProfile(profileName: string): string {
  const src = path.join(CHROME_USER_DATA, profileName);
  const dest = `${TMP_PROFILE_BASE}_${profileName.replace(/ /g, "_")}`;
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  // Use cp -a to preserve symlinks
  execSync(`cp -a "${src}" "${dest}"`);
  log.info(`Copied profile '${profileName}' → ${dest}`);
  return dest;
}

function extractThreadId(url: string): string | null {
  const m = url.match(/\/messaging\/thread\/([^/?#]+)/);
  return m ? m[1] : null;
}

function isLoggedIn(url: string): boolean {
  return !url.includes("/login") && !url.includes("/checkpoint") && !url.includes("/uas/");
}

// ── Core scrape ───────────────────────────────────────────────────────────────

async function getAccountName(page: Page): Promise<string> {
  try {
    const meImg = page.locator("img.global-nav__me-photo").first();
    const alt = await meImg.getAttribute("alt", { timeout: 5000 });
    if (alt?.trim()) return alt.trim();
  } catch {
    // ignore
  }
  return "Unknown";
}

async function scrapeMessageThread(
  page: Page,
  threadId: string,
  accountName: string
): Promise<Message[]> {
  const messages: Message[] = [];
  try {
    await page.waitForSelector(".msg-s-event-listitem", { timeout: 10000 });
    await page.waitForTimeout(800);

    const results = await page.evaluate((): RawMessageEntry[] => {
      const items = document.querySelectorAll(".msg-s-event-listitem");
      let currentSender = "";
      let currentSenderUrl = "";
      const out: RawMessageEntry[] = [];
      items.forEach((li, idx) => {
        const senderSpan = li.querySelector<HTMLElement>(".msg-s-message-group__name");
        if (senderSpan) {
          currentSender = senderSpan.innerText.trim();
          const senderLink =
            senderSpan.closest("a") ??
            senderSpan.parentElement?.closest("a");
          currentSenderUrl = senderLink ? senderLink.getAttribute("href") ?? "" : "";
        }
        const bodyEl = li.querySelector<HTMLElement>(".msg-s-event-listitem__body");
        if (!bodyEl) return;
        const body = bodyEl.innerText.trim();
        if (!body) return;
        const tsEl = li.querySelector<HTMLElement>("time, .msg-s-message-group__timestamp");
        const ts = tsEl
          ? tsEl.getAttribute("datetime") ?? tsEl.innerText.trim()
          : "";
        out.push({ idx, sender: currentSender, sender_url: currentSenderUrl, body, ts });
      });
      return out;
    });

    const lastN = results.length > MESSAGES_PER_CONV
      ? results.slice(-MESSAGES_PER_CONV)
      : results;

    for (const entry of lastN) {
      const senderName = (entry.sender ?? "").trim();
      const acctLower = accountName.toLowerCase();
      const direction: "outgoing" | "incoming" =
        acctLower && senderName.toLowerCase().includes(acctLower)
          ? "outgoing"
          : "incoming";
      messages.push({
        message_id: `${threadId}_${entry.idx}`,
        sender_name: senderName,
        sender_profile_url: (entry.sender_url ?? "").split("?")[0],
        direction,
        body: entry.body ?? "",
        timestamp: entry.ts ?? "",
      });
    }
  } catch (e) {
    log.warning(`  Failed to scrape messages from thread ${threadId}: ${e}`);
  }
  return messages;
}

async function sendReply(
  page: Page,
  replyText: string,
  profileName: string
): Promise<void> {
  const inputBox = page.locator(".msg-form__contenteditable").first();
  await inputBox.waitFor({ timeout: 10000 });
  await inputBox.click();
  await inputBox.fill(replyText);
  await page.waitForTimeout(500);

  const sendBtn = page.locator("button.msg-form__send-button").first();
  const sendCount = await sendBtn.count();
  if (sendCount > 0) {
    await sendBtn.click();
  } else {
    await inputBox.press("Enter");
  }

  await page.waitForTimeout(2000);
  log.info(`[${profileName}] Reply sent successfully`);
}

async function scrapeProfile(
  profileName: string,
  replyArgs: ReplyArgs | null = null
): Promise<InboxResult> {
  const result: InboxResult = {
    profile: profileName,
    account_name: "",
    scraped_at: new Date().toISOString(),
    status: "ok",
    conversations: [],
  };

  const tmpProfilePath = copyProfile(profileName);

  try {
    const browser = await chromium.launchPersistentContext(CHROME_USER_DATA, {
      headless: true,
      executablePath: CHROME_EXECUTABLE,
      args: [...CHROME_ARGS, `--profile-directory=${profileName}`],
    });

    const page = browser.pages()[0] ?? (await browser.newPage());

    // ── Reply mode ────────────────────────────────────────────────────────
    if (replyArgs) {
      const url = `https://www.linkedin.com/messaging/thread/${replyArgs.conversation_id}/`;
      log.info(`[${profileName}] Navigating to thread for reply: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);

      if (!isLoggedIn(page.url())) {
        result.status = "not_logged_in";
        log.warning(`[${profileName}] Not logged in — cannot reply`);
        await browser.close();
        return result;
      }

      await sendReply(page, replyArgs.text, profileName);
      result.status = "replied";
      await browser.close();
      return result;
    }

    // ── Scrape mode ───────────────────────────────────────────────────────
    log.info(`[${profileName}] Opening LinkedIn Messaging...`);
    await page.goto("https://www.linkedin.com/messaging/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    if (!isLoggedIn(page.url())) {
      result.status = "not_logged_in";
      log.warning(`[${profileName}] Not logged in`);
      await browser.close();
      return result;
    }

    try {
      const accountName = await getAccountName(page);
      result.account_name = accountName;
      log.info(`[${profileName}] Logged in as: ${accountName}`);
    } catch {
      // non-fatal
    }

    try {
      await page.waitForSelector("li.msg-conversation-listitem", { timeout: 10000 });
    } catch {
      log.warning(`[${profileName}] No conversation list found`);
      await page.screenshot({ path: `/tmp/linkedin_${profileName}_error.png` });
      result.status = "error";
      await browser.close();
      return result;
    }

    // Scroll sidebar to load more conversations
    const sidebar = page
      .locator(".msg-conversations-container__conversations-list, ul.artdeco-list")
      .first();
    for (let i = 0; i < 3; i++) {
      try {
        await sidebar.evaluate((el: Element) => el.scrollBy(0, 600));
        await page.waitForTimeout(800);
      } catch {
        break;
      }
    }

    let convItems = await page.locator("li.msg-conversation-listitem").all();
    log.info(`[${profileName}] Found ${convItems.length} conversations in sidebar`);
    convItems = convItems.slice(0, CONVERSATIONS_TO_FETCH);

    for (let idx = 0; idx < convItems.length; idx++) {
      const item = convItems[idx];
      const convData: Conversation = {
        conversation_id: "",
        sender_name: "",
        sender_profile_url: "",
        unread: false,
        needs_reply: false,
        last_message_direction: "unknown",
        last_message_preview: "",
        timestamp: "",
        messages: [],
      };

      try {
        const nameEl = item.locator("h3.msg-conversation-listitem__participant-names");
        convData.sender_name = (await nameEl.innerText({ timeout: 3000 })).trim();

        const nameClasses = (await nameEl.getAttribute("class")) ?? "";
        convData.unread = nameClasses.includes("t-bold") && !nameClasses.includes("t-normal");

        try {
          const previewEl = item.locator("p.msg-conversation-card__message-snippet");
          convData.last_message_preview = (await previewEl.innerText({ timeout: 2000 })).trim();
        } catch {
          // no preview
        }

        try {
          const timeEl = item.locator("time.msg-conversation-listitem__time-stamp");
          convData.timestamp = (await timeEl.innerText({ timeout: 2000 })).trim();
        } catch {
          // no timestamp
        }

        const clickTarget = item.locator("div.msg-conversation-listitem__link").first();
        await clickTarget.click({ timeout: 5000 });
        await page.waitForTimeout(2500);

        const threadId = extractThreadId(page.url());
        convData.conversation_id = threadId ?? `unknown_${idx}`;

        try {
          const linkEl = page.locator(".msg-s-message-group__name a").first();
          const href = await linkEl.getAttribute("href", { timeout: 3000 });
          if (href) convData.sender_profile_url = href.split("?")[0];
        } catch {
          // no sender link
        }

        convData.messages = await scrapeMessageThread(
          page,
          convData.conversation_id,
          result.account_name
        );

        if (convData.messages.length > 0) {
          const lastMsg = convData.messages[convData.messages.length - 1];
          convData.needs_reply = lastMsg.direction === "incoming";
          convData.last_message_direction = lastMsg.direction;
        }

        const icon = convData.needs_reply ? "NEEDS REPLY" : "sent";
        log.info(
          `[${profileName}]  [${idx + 1}] ${convData.sender_name.slice(0, 35)} — ${convData.messages.length} msgs | ${icon} | thread: ${convData.conversation_id}`
        );
      } catch (e) {
        log.warning(`[${profileName}]  [${idx + 1}] ERROR processing conversation: ${e}`);
        await page.screenshot({ path: `/tmp/linkedin_${profileName}_conv${idx}_error.png` });
      }

      result.conversations.push(convData);
    }

    await browser.close();
  } catch (e) {
    log.error(`[${profileName}] Fatal error: ${e}`);
    result.status = "error";
    result.error = String(e);
  } finally {
    try {
      fs.rmSync(tmpProfilePath, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(args: {
  profile?: string;
  reply: boolean;
  conversationId?: string;
  text?: string;
}): Promise<InboxResult[]> {
  const profiles = args.profile ? [args.profile] : discoverProfiles();
  log.info(`Profiles to process: ${profiles.join(", ")}`);

  const statusMap: Record<string, string> = {};
  const allResults: InboxResult[] = [];
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "T");

  for (let i = 0; i < profiles.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 3000));

    const profileName = profiles[i];

    let replyArgs: ReplyArgs | null = null;
    if (args.reply) {
      if (!args.conversationId || !args.text) {
        log.error("--reply requires --conversation-id and --text");
        process.exit(1);
      }
      replyArgs = { conversation_id: args.conversationId, text: args.text };
    }

    try {
      const result = await scrapeProfile(profileName, replyArgs);
      allResults.push(result);
      statusMap[profileName] = result.status;

      if (!args.reply) {
        const safeName = profileName.replace(/ /g, "");
        const outPath = path.join(OUTPUT_DIR, `linkedin_inbox_${safeName}_${timestamp}.json`);
        fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");
        log.info(`Results written to ${outPath}`);

        const unreadCount = result.conversations.filter((c) => c.unread).length;
        const needsReplyCount = result.conversations.filter((c) => c.needs_reply).length;
        const total = result.conversations.length;

        console.log(`\n${"=".repeat(60)}`);
        console.log(`[${profileName}] ${result.account_name}`);
        console.log(`  ${total} conversations | ${unreadCount} unread | ${needsReplyCount} need reply`);
        console.log(`  Output: ${outPath}`);

        const needReply = result.conversations.filter((c) => c.needs_reply);
        if (needReply.length > 0) {
          console.log(`\n  Threads needing reply:`);
          for (const c of needReply) {
            const lastMsg = c.messages[c.messages.length - 1] ?? null;
            console.log(`    • ${c.sender_name} (${c.timestamp})`);
            console.log(`      Thread: ${c.conversation_id}`);
            if (lastMsg) console.log(`      Last msg: ${lastMsg.body.slice(0, 120)}`);
            console.log();
          }
        } else {
          console.log(`\n  No threads need reply — all last messages are outgoing.`);
        }
        console.log("=".repeat(60));
      }
    } catch (e) {
      log.error(`Profile ${profileName} failed: ${e}`);
      statusMap[profileName] = "error";
    }
  }

  const statusPath = path.join(OUTPUT_DIR, "linkedin_status.json");
  const statusOut: StatusMap = { timestamp, profiles: statusMap };
  fs.writeFileSync(statusPath, JSON.stringify(statusOut, null, 2));
  log.info(`Status written to ${statusPath}`);

  return allResults;
}

function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: "string" },
      reply: { type: "boolean", default: false },
      "conversation-id": { type: "string" },
      text: { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  run({
    profile: values.profile as string | undefined,
    reply: (values.reply as boolean) ?? false,
    conversationId: values["conversation-id"] as string | undefined,
    text: values.text as string | undefined,
  }).catch((e) => {
    console.error(e);
    process.exit(0); // exit 0 for cron safety (matches Python version)
  });
}

main();
