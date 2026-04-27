import "dotenv/config";
import os from "os";
import path from "node:path";

const tmp = os.tmpdir();

function envString(key: string, fallback: string): string {
  const v = process.env[key];
  return v != null && v.trim() !== "" ? v : fallback;
}

/** Playwright uses this Chromium/Chrome binary. */
export const CHROME_EXECUTABLE = envString(
  "LINKEDIN_CHROME_EXECUTABLE",
  "/snap/chromium/current/usr/lib/chromium-browser/chrome"
);

/** User data directory where Default / Profile 1, … live. */
export const CHROME_USER_DATA = envString(
  "LINKEDIN_CHROME_USER_DATA",
  "/home/ahmad/snap/chromium/common/chromium"
);

/** Per-run copies of Chrome profiles (inbox) live under this prefix. */
export const TMP_PROFILE_BASE = envString(
  "LINKEDIN_TMP_PROFILE_BASE",
  path.join(tmp, "linkedin_pw")
);

/** JSON exports, status files, and mention state. */
export const OUTPUT_DIR = envString("LINKEDIN_OUTPUT_DIR", tmp);

export const LOG_FILE = envString(
  "LINKEDIN_LOG_FILE",
  path.join(tmp, "linkedin_inbox.log")
);

export const CONVERSATIONS_TO_FETCH = 10;
export const MESSAGES_PER_CONV = 5;

export const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--password-store=basic",
];
