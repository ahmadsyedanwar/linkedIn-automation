import path from "path";
import type { Locator, Page } from "playwright";
import { CONVERSATIONS_TO_FETCH, MESSAGES_PER_CONV, OUTPUT_DIR } from "../config.js";
import { log } from "../logger.js";
import type { Message, RawMessageEntry } from "../types.js";
import { extractThreadIdFromMessagingUrl } from "../utils/linkedinSession.js";
import { LinkedInBasePage } from "./LinkedInBasePage.js";

const MESSAGING_URL = "https://www.linkedin.com/messaging/";

/**
 * Page object for LinkedIn messaging (inbox list + thread + reply).
 */
export class MessagingPage extends LinkedInBasePage {
  private static readonly convListItem = "li.msg-conversation-listitem";
  private static readonly convSidebar =
    ".msg-conversations-container__conversations-list, ul.artdeco-list";
  private static readonly messageListItem = ".msg-s-event-listitem";
  private static readonly inputContentEditable = ".msg-form__contenteditable";
  private static readonly sendButton = "button.msg-form__send-button";

  constructor(page: Page) {
    super(page);
  }

  threadUrlForConversation(conversationId: string): string {
    return `https://www.linkedin.com/messaging/thread/${conversationId}/`;
  }

  async gotoMessagingHome(): Promise<void> {
    await this.page.goto(MESSAGING_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await this.page.waitForTimeout(4000);
  }

  async gotoThreadForReply(conversationId: string): Promise<void> {
    const url = this.threadUrlForConversation(conversationId);
    log.info(`Navigating to thread for reply: ${url}`);
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.page.waitForTimeout(3000);
  }

  async hasConversationList(): Promise<boolean> {
    try {
      await this.page.waitForSelector(MessagingPage.convListItem, {
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async takeMessagingErrorShot(profileName: string): Promise<void> {
    await this.page.screenshot({
      path: path.join(OUTPUT_DIR, `linkedin_${profileName}_error.png`),
    });
  }

  private get sidebar() {
    return this.page
      .locator(MessagingPage.convSidebar)
      .first();
  }

  async scrollConversationSidebar(): Promise<void> {
    const sidebar = this.sidebar;
    for (let i = 0; i < 3; i++) {
      try {
        await sidebar.evaluate((el: Element) => el.scrollBy(0, 600));
        await this.page.waitForTimeout(800);
      } catch {
        break;
      }
    }
  }

  async getConversationListItems(
    maxItems: number = CONVERSATIONS_TO_FETCH
  ): Promise<Locator[]> {
    const all = await this.page.locator(MessagingPage.convListItem).all();
    return all.slice(0, maxItems);
  }

  threadIdFromUrl(): string | null {
    return extractThreadIdFromMessagingUrl(this.page.url());
  }

  /**
   * Parses a row in the conversation list and opens that thread; caller supplies index for logging.
   */
  async openConversationListItem(
    item: Locator
  ): Promise<{
    sender_name: string;
    unread: boolean;
    last_message_preview: string;
    timestamp: string;
  }> {
    const out = {
      sender_name: "",
      unread: false,
      last_message_preview: "",
      timestamp: "",
    };
    const nameEl = item.locator("h3.msg-conversation-listitem__participant-names");
    out.sender_name = (await nameEl.innerText({ timeout: 3000 })).trim();
    const nameClasses = (await nameEl.getAttribute("class")) ?? "";
    out.unread =
      nameClasses.includes("t-bold") && !nameClasses.includes("t-normal");
    try {
      const previewEl = item.locator("p.msg-conversation-card__message-snippet");
      out.last_message_preview = (
        await previewEl.innerText({ timeout: 2000 })
      ).trim();
    } catch {
      // no preview
    }
    try {
      const timeEl = item.locator("time.msg-conversation-listitem__time-stamp");
      out.timestamp = (await timeEl.innerText({ timeout: 2000 })).trim();
    } catch {
      // no timestamp
    }
    const clickTarget = item
      .locator("div.msg-conversation-listitem__link")
      .first();
    await clickTarget.click({ timeout: 5000 });
    await this.page.waitForTimeout(2500);
    return out;
  }

  async getSenderProfileUrlFromOpenThread(): Promise<string> {
    try {
      const linkEl = this.page
        .locator(".msg-s-message-group__name a")
        .first();
      const href = await linkEl.getAttribute("href", { timeout: 3000 });
      if (href) return href.split("?")[0];
    } catch {
      // no sender link
    }
    return "";
  }

  /**
   * Reads the currently open thread into structured messages.
   */
  async readCurrentThreadMessages(
    threadId: string,
    accountName: string
  ): Promise<Message[]> {
    const messages: Message[] = [];
    const page = this.page;
    try {
      await page.waitForSelector(MessagingPage.messageListItem, {
        timeout: 10000,
      });
      await page.waitForTimeout(800);

      const results = await page.evaluate((): RawMessageEntry[] => {
        const items = document.querySelectorAll(".msg-s-event-listitem");
        let currentSender = "";
        let currentSenderUrl = "";
        const out: RawMessageEntry[] = [];
        items.forEach((li, idx) => {
          const senderSpan = li.querySelector<HTMLElement>(
            ".msg-s-message-group__name"
          );
          if (senderSpan) {
            currentSender = senderSpan.innerText.trim();
            const senderLink =
              senderSpan.closest("a") ??
              senderSpan.parentElement?.closest("a");
            currentSenderUrl = senderLink
              ? (senderLink.getAttribute("href") ?? "")
              : "";
          }
          const bodyEl = li.querySelector<HTMLElement>(
            ".msg-s-event-listitem__body"
          );
          if (!bodyEl) return;
          const body = bodyEl.innerText.trim();
          if (!body) return;
          const tsEl = li.querySelector<HTMLElement>(
            "time, .msg-s-message-group__timestamp"
          );
          const ts = tsEl
            ? tsEl.getAttribute("datetime") ?? tsEl.innerText.trim()
            : "";
          out.push({
            idx,
            sender: currentSender,
            sender_url: currentSenderUrl,
            body,
            ts,
          });
        });
        return out;
      });

      const lastN =
        results.length > MESSAGES_PER_CONV
          ? results.slice(-MESSAGES_PER_CONV)
          : results;

      const acctLower = accountName.toLowerCase();
      for (const entry of lastN) {
        const senderName = (entry.sender ?? "").trim();
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

  async sendReplyInOpenThread(
    replyText: string,
    profileName: string
  ): Promise<void> {
    const inputBox = this.page
      .locator(MessagingPage.inputContentEditable)
      .first();
    await inputBox.waitFor({ timeout: 10000 });
    await inputBox.click();
    await inputBox.fill(replyText);
    await this.page.waitForTimeout(500);
    const sendBtn = this.page
      .locator(MessagingPage.sendButton)
      .first();
    if ((await sendBtn.count()) > 0) {
      await sendBtn.click();
    } else {
      await inputBox.press("Enter");
    }
    await this.page.waitForTimeout(2000);
    log.info(`[${profileName}] Reply sent successfully`);
  }

  async takeConversationItemErrorShot(
    profileName: string,
    idx: number
  ): Promise<void> {
    await this.page.screenshot({
      path: path.join(OUTPUT_DIR, `linkedin_${profileName}_conv${idx}_error.png`),
    });
  }
}
