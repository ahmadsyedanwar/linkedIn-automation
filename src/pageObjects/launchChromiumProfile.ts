import { chromium, type BrowserContext, type Page } from "playwright";
import { CHROME_ARGS, CHROME_EXECUTABLE, CHROME_USER_DATA } from "../config.js";

/**
 * Launches a persistent Chromium context for a named Chrome profile (Default, Profile 1, …).
 */
export async function launchChromiumForProfile(
  profileName: string
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(CHROME_USER_DATA, {
    headless: true,
    executablePath: CHROME_EXECUTABLE,
    args: [...CHROME_ARGS, `--profile-directory=${profileName}`],
  });
}

export async function getOrCreateFirstPage(
  context: BrowserContext
): Promise<Page> {
  return context.pages()[0] ?? (await context.newPage());
}
