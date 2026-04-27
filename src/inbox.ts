#!/usr/bin/env node
/**
 * inbox.ts — Multi-profile LinkedIn inbox reader + reply tool using Playwright.
 *
 * Usage:
 *   npx ts-node src/inbox.ts                          # scrape all profiles
 *   npx ts-node src/inbox.ts --profile Default        # scrape one profile
 *   npx ts-node src/inbox.ts --profile Default --reply --conversation-id THREAD_ID --text "Hello!"
 */

import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import { CHROME_USER_DATA, OUTPUT_DIR, TMP_PROFILE_BASE } from "./config.js";
import { log } from "./logger.js";
import {
  getOrCreateFirstPage,
  launchChromiumForProfile,
  MessagingPage,
} from "./pageObjects/index.js";
import type {
  Conversation,
  InboxResult,
  ReplyArgs,
  StatusMap,
} from "./types.js";

// ── Filesystem (profiles on disk) ─────────────────────────────────────────────

function discoverProfiles(chromeUserData: string): string[] {
  const entries = fs.readdirSync(chromeUserData, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isDirectory() &&
        (e.name === "Default" || /^Profile \d+$/.test(e.name))
    )
    .map((e) => e.name)
    .sort();
}

function copyProfile(
  chromeUserData: string,
  tmpProfileBase: string,
  profileName: string
): string {
  const src = path.join(chromeUserData, profileName);
  const dest = `${tmpProfileBase}_${profileName.replace(/ /g, "_")}`;
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.cpSync(src, dest, { recursive: true, force: true });
  log.info(`Copied profile '${profileName}' → ${dest}`);
  return dest;
}

// ── Inbox flow (page objects + AAA) — Arrange / Act / Assert sections in scrapeProfile ─

async function scrapeProfile(
  profileName: string,
  replyArgs: ReplyArgs | null = null
): Promise<InboxResult> {
  // —— Arrange
  const result: InboxResult = {
    profile: profileName,
    account_name: "",
    scraped_at: new Date().toISOString(),
    status: "ok",
    conversations: [],
  };

  const tmpProfilePath = copyProfile(
    CHROME_USER_DATA,
    TMP_PROFILE_BASE,
    profileName
  );

  let browser: Awaited<ReturnType<typeof launchChromiumForProfile>> | null =
    null;

  try {
    browser = await launchChromiumForProfile(profileName);
    const page = await getOrCreateFirstPage(browser);
    const messaging = new MessagingPage(page);

    if (replyArgs) {
      // —— Act (reply)
      await messaging.gotoThreadForReply(replyArgs.conversation_id);
      // —— Assert
      if (!messaging.isLoggedIn()) {
        result.status = "not_logged_in";
        log.warning(`[${profileName}] Not logged in — cannot reply`);
        return result;
      }
      await messaging.sendReplyInOpenThread(replyArgs.text, profileName);
      result.status = "replied";
      return result;
    }

    // —— Act (inbox list + threads)
    log.info(`[${profileName}] Opening LinkedIn Messaging...`);
    await messaging.gotoMessagingHome();
    // —— Assert (session)
    if (!messaging.isLoggedIn()) {
      result.status = "not_logged_in";
      log.warning(`[${profileName}] Not logged in`);
      return result;
    }
    try {
      result.account_name = await messaging.getAccountNameFromNav();
      log.info(`[${profileName}] Logged in as: ${result.account_name}`);
    } catch {
      // non-fatal
    }

    if (!(await messaging.hasConversationList())) {
      log.warning(`[${profileName}] No conversation list found`);
      await messaging.takeMessagingErrorShot(profileName);
      result.status = "error";
      return result;
    }

    await messaging.scrollConversationSidebar();
    const convItems = await messaging.getConversationListItems();

    log.info(
      `[${profileName}] Found ${convItems.length} conversations in sidebar`
    );

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
        const row = await messaging.openConversationListItem(item);
        convData.sender_name = row.sender_name;
        convData.unread = row.unread;
        convData.last_message_preview = row.last_message_preview;
        convData.timestamp = row.timestamp;
        convData.conversation_id =
          messaging.threadIdFromUrl() ?? `unknown_${idx}`;
        convData.sender_profile_url =
          await messaging.getSenderProfileUrlFromOpenThread();
        convData.messages = await messaging.readCurrentThreadMessages(
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
        log.warning(
          `[${profileName}]  [${idx + 1}] ERROR processing conversation: ${e}`
        );
        await messaging.takeConversationItemErrorShot(profileName, idx);
      }
      result.conversations.push(convData);
    }
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
    try {
      fs.rmSync(tmpProfilePath, { recursive: true, force: true });
    } catch {
      // ignore
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
  const profiles = args.profile
    ? [args.profile]
    : discoverProfiles(CHROME_USER_DATA);
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
        const outPath = path.join(
          OUTPUT_DIR,
          `linkedin_inbox_${safeName}_${timestamp}.json`
        );
        fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");
        log.info(`Results written to ${outPath}`);

        const unreadCount = result.conversations.filter((c) => c.unread).length;
        const needsReplyCount = result.conversations.filter(
          (c) => c.needs_reply
        ).length;
        const total = result.conversations.length;

        console.log(`\n${"=".repeat(60)}`);
        console.log(`[${profileName}] ${result.account_name}`);
        console.log(
          `  ${total} conversations | ${unreadCount} unread | ${needsReplyCount} need reply`
        );
        console.log(`  Output: ${outPath}`);

        const needReply = result.conversations.filter((c) => c.needs_reply);
        if (needReply.length > 0) {
          console.log(`\n  Threads needing reply:`);
          for (const c of needReply) {
            const lastMsg = c.messages[c.messages.length - 1] ?? null;
            console.log(`    • ${c.sender_name} (${c.timestamp})`);
            console.log(`      Thread: ${c.conversation_id}`);
            if (lastMsg)
              console.log(`      Last msg: ${lastMsg.body.slice(0, 120)}`);
            console.log();
          }
        } else {
          console.log(
            `\n  No threads need reply — all last messages are outgoing.`
          );
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
    process.exit(0);
  });
}

main();
