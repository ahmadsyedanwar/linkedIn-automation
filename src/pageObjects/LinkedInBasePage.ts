import type { Page } from "playwright";
import { isLoggedInUrl } from "../utils/linkedinSession.js";

/**
 * Cross-page LinkedIn UI shared by automation (global nav, session).
 */
export class LinkedInBasePage {
  static isLoggedInUrl = isLoggedInUrl;

  constructor(protected readonly page: Page) {}

  get currentUrl(): string {
    return this.page.url();
  }

  isLoggedIn(): boolean {
    return isLoggedInUrl(this.currentUrl);
  }

  async getAccountNameFromNav(): Promise<string> {
    try {
      const meImg = this.page.locator("img.global-nav__me-photo").first();
      const alt = await meImg.getAttribute("alt", { timeout: 5000 });
      if (alt?.trim()) return alt.trim();
    } catch {
      // ignore
    }
    return "Unknown";
  }
}
