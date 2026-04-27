import path from "path";
import type { Page } from "playwright";
import { OUTPUT_DIR } from "../config.js";
import { log } from "../logger.js";
import type { RawMention } from "../types.js";
import { LinkedInBasePage } from "./LinkedInBasePage.js";

const MENTIONS_URL = "https://www.linkedin.com/notifications/?filter=mentions";

/**
 * Page object for LinkedIn notifications filtered to @mentions.
 */
export class MentionsPage extends LinkedInBasePage {
  private static readonly mentionCard = "article.nt-card";
  private static readonly loadNewNotifications =
    "button[aria-label='Load new notifications']";

  constructor(page: Page) {
    super(page);
  }

  async openMentionsFilter(profileName: string): Promise<void> {
    log.info(`[${profileName}] Navigating to mentions filter...`);
    await this.page.goto(MENTIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await this.page.waitForTimeout(4000);
  }

  async clickLoadNewNotificationsIfPresent(profileName: string): Promise<void> {
    try {
      const newBtn = this.page
        .locator(MentionsPage.loadNewNotifications)
        .first();
      if ((await newBtn.count()) > 0) {
        await newBtn.click();
        await this.page.waitForTimeout(2000);
        log.info(`[${profileName}] Clicked 'Load new notifications'`);
      }
    } catch {
      // not present — fine
    }
  }

  async waitForMentionCardsOrCaptureError(
    profileName: string
  ): Promise<boolean> {
    try {
      await this.page.waitForSelector(MentionsPage.mentionCard, {
        timeout: 10000,
      });
      return true;
    } catch {
      log.warning(
        `[${profileName}] No notification cards found on mentions page`
      );
      await this.page.screenshot({
        path: path.join(OUTPUT_DIR, `linkedin_mentions_${profileName}_error.png`),
      });
      return false;
    }
  }

  async scrollToLoadMoreNotifications(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.page.evaluate(() => window.scrollBy(0, 800));
      await this.page.waitForTimeout(700);
    }
  }

  /**
   * Extracts raw mention card data from the current DOM.
   */
  async readMentionCardDom(): Promise<RawMention[]> {
    return this.page.evaluate((): RawMention[] => {
      const articles = document.querySelectorAll<HTMLElement>("article.nt-card");
      const results: RawMention[] = [];
      articles.forEach((article) => {
        const headlineEl = article.querySelector<HTMLElement>(".nt-card__headline");
        const headlineText = headlineEl?.innerText?.trim() ?? "";
        if (!headlineText.toLowerCase().includes("mentioned you")) return;
        const cardIndex = article.getAttribute("data-nt-card-index") ?? "";
        const authorLinkEl = article.querySelector<HTMLAnchorElement>(
          'a[data-view-name="notification-card-image"]'
        );
        const authorProfileUrl = authorLinkEl
          ? `https://www.linkedin.com${authorLinkEl.getAttribute("href") ?? ""}`.split(
              "?"
            )[0]
          : "";
        const firstStrong = headlineEl?.querySelector<HTMLElement>("strong");
        const authorName = firstStrong?.innerText?.trim() ?? "";
        const headlineLink = article.querySelector<HTMLAnchorElement>(
          "a.nt-card__headline"
        );
        const rawHref = headlineLink?.getAttribute("href") ?? "";
        const postUrl = rawHref
          ? `https://www.linkedin.com${rawHref}`
          : "";
        const previewEl = article.querySelector<HTMLElement>(
          ".nt-card__text--2-line-large, .nt-card-content__body-text"
        );
        const commentPreview = previewEl?.innerText?.trim() ?? "";
        const timeAgo =
          article
            .querySelector<HTMLElement>(".nt-card__time-ago")
            ?.innerText?.trim() ?? "";
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
}
