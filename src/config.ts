export const CHROME_EXECUTABLE = "/snap/chromium/current/usr/lib/chromium-browser/chrome";
export const CHROME_USER_DATA = "/home/ahmad/snap/chromium/common/chromium";
export const TMP_PROFILE_BASE = "/tmp/linkedin_pw";
export const OUTPUT_DIR = "/tmp";
export const LOG_FILE = "/tmp/linkedin_inbox.log";
export const CONVERSATIONS_TO_FETCH = 10;
export const MESSAGES_PER_CONV = 5;

export const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--password-store=basic",
];
