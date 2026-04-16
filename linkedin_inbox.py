#!/usr/bin/env python3
"""
linkedin_inbox.py — Multi-profile LinkedIn inbox reader + reply tool using Playwright.

Usage:
  python3 linkedin_inbox.py                          # scrape all profiles
  python3 linkedin_inbox.py --profile Default        # scrape one profile
  python3 linkedin_inbox.py --profile Default --reply --conversation-id THREAD_ID --text "Hello!"
"""

import asyncio
import argparse
import json
import logging
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from playwright.async_api import async_playwright, TimeoutError as PWTimeout

# ── Config ────────────────────────────────────────────────────────────────────
CHROME_EXECUTABLE = "/snap/chromium/current/usr/lib/chromium-browser/chrome"
CHROME_USER_DATA   = "/home/ahmad/snap/chromium/common/chromium"
TMP_PROFILE_BASE   = "/tmp/linkedin_pw"
OUTPUT_DIR         = "/tmp"
LOG_FILE           = "/tmp/linkedin_inbox.log"
CONVERSATIONS_TO_FETCH = 10
MESSAGES_PER_CONV      = 5

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────

def discover_profiles() -> list[str]:
    """Return sorted list of profile directory names found in CHROME_USER_DATA."""
    root = Path(CHROME_USER_DATA)
    profiles = []
    for p in root.iterdir():
        if p.is_dir() and (p.name == "Default" or re.match(r"^Profile \d+$", p.name)):
            profiles.append(p.name)
    return sorted(profiles)


def copy_profile(profile_name: str) -> str:
    """Copy a Chromium profile to a temp dir to avoid lock conflicts."""
    src  = Path(CHROME_USER_DATA) / profile_name
    dest = Path(f"{TMP_PROFILE_BASE}_{profile_name.replace(' ', '_')}")
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(src, dest, symlinks=True)
    log.info(f"Copied profile '{profile_name}' → {dest}")
    return str(dest)


def extract_thread_id(url: str) -> str | None:
    m = re.search(r"/messaging/thread/([^/?#]+)", url)
    return m.group(1) if m else None


def is_logged_in(url: str) -> bool:
    return "/login" not in url and "/checkpoint" not in url and "/uas/" not in url


# ── Core scrape ───────────────────────────────────────────────────────────────

async def get_account_name(page) -> str:
    """Get the logged-in user's display name from the nav profile photo alt text."""
    try:
        me_img = page.locator("img.global-nav__me-photo").first
        alt = await me_img.get_attribute("alt", timeout=5000)
        if alt and alt.strip():
            return alt.strip()
    except Exception:
        pass
    return "Unknown"


async def scrape_message_thread(page, thread_id: str, account_name: str) -> list[dict]:
    """Scrape last MESSAGES_PER_CONV messages from the currently open thread.
    
    Strategy: iterate ALL event list items in order, tracking 'current sender' whenever
    a group header (.msg-s-message-group__meta) is encountered. Associate each body
    item with the last seen sender.
    """
    messages = []
    try:
        await page.wait_for_selector(".msg-s-event-listitem", timeout=10000)
        await page.wait_for_timeout(800)

        # Use JS to walk the full event list once, extracting all (sender, body, ts) tuples
        results = await page.evaluate("""
            () => {
                const items = document.querySelectorAll('.msg-s-event-listitem');
                let currentSender = '';
                let currentSenderUrl = '';
                const out = [];
                items.forEach((li, idx) => {
                    // Update sender if this item has a group header
                    // Structure: <a href="..."><span class="msg-s-message-group__name">Name</span></a>
                    const senderSpan = li.querySelector('.msg-s-message-group__name');
                    if (senderSpan) {
                        currentSender = senderSpan.innerText.trim();
                        const senderLink = senderSpan.closest('a') || senderSpan.parentElement.closest('a');
                        currentSenderUrl = senderLink ? (senderLink.href || '') : '';
                    }
                    // Extract body
                    const bodyEl = li.querySelector('.msg-s-event-listitem__body');
                    if (!bodyEl) return; // date separator / system
                    const body = bodyEl.innerText.trim();
                    if (!body) return;
                    // Timestamp
                    const tsEl = li.querySelector('time, .msg-s-message-group__timestamp');
                    const ts = tsEl ? (tsEl.getAttribute('datetime') || tsEl.innerText.trim()) : '';
                    out.push({idx, sender: currentSender, sender_url: currentSenderUrl, body, ts});
                });
                return out;
            }
        """)

        # Take only the last N messages
        last_n = results[-MESSAGES_PER_CONV:] if len(results) > MESSAGES_PER_CONV else results

        for entry in last_n:
            sender_name = entry.get("sender", "").strip()
            acct_lower = account_name.lower() if account_name else ""
            direction = "outgoing" if acct_lower and acct_lower in sender_name.lower() else "incoming"
            messages.append({
                "message_id": f"{thread_id}_{entry['idx']}",
                "sender_name": sender_name,
                "sender_profile_url": entry.get("sender_url", "").split("?")[0],
                "direction": direction,
                "body": entry.get("body", ""),
                "timestamp": entry.get("ts", ""),
            })
    except Exception as e:
        log.warning(f"  Failed to scrape messages from thread {thread_id}: {e}")
    return messages


async def scrape_profile(profile_name: str, reply_args: dict | None = None) -> dict:
    """Scrape inbox for one Chromium profile. Returns a result dict."""
    result = {
        "profile": profile_name,
        "account_name": "",
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "status": "ok",
        "conversations": [],
    }

    tmp_profile_path = copy_profile(profile_name)

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch_persistent_context(
                user_data_dir=CHROME_USER_DATA,
                headless=True,
                executable_path=CHROME_EXECUTABLE,
                args=[
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    f"--profile-directory={profile_name}",
                    "--disable-blink-features=AutomationControlled",
                    "--password-store=basic",
                ],
            )

            page = browser.pages[0] if browser.pages else await browser.new_page()

            # ── If replying, go directly to the thread ────────────────────────
            if reply_args:
                thread_id = reply_args["conversation_id"]
                reply_text = reply_args["text"]
                url = f"https://www.linkedin.com/messaging/thread/{thread_id}/"
                log.info(f"[{profile_name}] Navigating to thread for reply: {url}")
                await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                await page.wait_for_timeout(3000)
                if not is_logged_in(page.url):
                    result["status"] = "not_logged_in"
                    log.warning(f"[{profile_name}] Not logged in — cannot reply")
                    await browser.close()
                    return result
                await _send_reply(page, reply_text, profile_name)
                result["status"] = "replied"
                await browser.close()
                return result

            # ── Navigate to messaging ─────────────────────────────────────────
            log.info(f"[{profile_name}] Opening LinkedIn Messaging...")
            await page.goto("https://www.linkedin.com/messaging/", wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(4000)

            if not is_logged_in(page.url):
                result["status"] = "not_logged_in"
                log.warning(f"[{profile_name}] Not logged in")
                await browser.close()
                return result

            # Take error screenshot fallback early
            try:
                account_name = await get_account_name(page)
                result["account_name"] = account_name
                log.info(f"[{profile_name}] Logged in as: {account_name}")
            except Exception:
                account_name = ""

            # ── Collect conversation list items ───────────────────────────────
            try:
                await page.wait_for_selector("li.msg-conversation-listitem", timeout=10000)
            except PWTimeout:
                log.warning(f"[{profile_name}] No conversation list found")
                await page.screenshot(path=f"/tmp/linkedin_{profile_name}_error.png")
                result["status"] = "error"
                await browser.close()
                return result

            # Scroll sidebar to load more conversations
            sidebar = page.locator(".msg-conversations-container__conversations-list, ul.artdeco-list").first
            for _ in range(3):
                try:
                    await sidebar.evaluate("el => el.scrollBy(0, 600)")
                    await page.wait_for_timeout(800)
                except Exception:
                    break

            conv_items = await page.locator("li.msg-conversation-listitem").all()
            log.info(f"[{profile_name}] Found {len(conv_items)} conversations in sidebar")
            conv_items = conv_items[:CONVERSATIONS_TO_FETCH]

            # ── For each conversation ─────────────────────────────────────────
            for idx, item in enumerate(conv_items):
                conv_data = {
                    "conversation_id": "",
                    "sender_name": "",
                    "sender_profile_url": "",
                    "unread": False,
                    "last_message_preview": "",
                    "timestamp": "",
                    "messages": [],
                }
                try:
                    # Name
                    name_el = item.locator("h3.msg-conversation-listitem__participant-names")
                    conv_data["sender_name"] = (await name_el.inner_text(timeout=3000)).strip()

                    # Unread — bold class on the name header means unread
                    name_classes = await name_el.get_attribute("class") or ""
                    conv_data["unread"] = "t-bold" in name_classes and "t-normal" not in name_classes

                    # Preview text
                    try:
                        preview_el = item.locator("p.msg-conversation-card__message-snippet")
                        conv_data["last_message_preview"] = (await preview_el.inner_text(timeout=2000)).strip()
                    except Exception:
                        pass

                    # Timestamp
                    try:
                        time_el = item.locator("time.msg-conversation-listitem__time-stamp")
                        conv_data["timestamp"] = (await time_el.inner_text(timeout=2000)).strip()
                    except Exception:
                        pass

                    # Click to open conversation
                    click_target = item.locator("div.msg-conversation-listitem__link").first
                    await click_target.click(timeout=5000)
                    await page.wait_for_timeout(2500)

                    # Extract thread ID from URL
                    thread_id = extract_thread_id(page.url)
                    conv_data["conversation_id"] = thread_id or f"unknown_{idx}"

                    # Try to get sender profile URL from message group header in thread
                    try:
                        link_el = page.locator(".msg-s-message-group__name a").first
                        href = await link_el.get_attribute("href", timeout=3000)
                        if href:
                            conv_data["sender_profile_url"] = href.split("?")[0]
                    except Exception:
                        pass

                    # Scrape messages
                    conv_data["messages"] = await scrape_message_thread(page, conv_data["conversation_id"], account_name)

                    log.info(f"[{profile_name}]  [{idx+1}] {conv_data['sender_name'][:35]} — {len(conv_data['messages'])} msgs | thread: {thread_id}")

                except Exception as e:
                    log.warning(f"[{profile_name}]  [{idx+1}] ERROR processing conversation: {e}")
                    await page.screenshot(path=f"/tmp/linkedin_{profile_name}_conv{idx}_error.png")

                result["conversations"].append(conv_data)

            await browser.close()

    except Exception as e:
        log.error(f"[{profile_name}] Fatal error: {e}")
        result["status"] = "error"
        result["error"] = str(e)
    finally:
        # Clean up temp profile copy
        try:
            shutil.rmtree(tmp_profile_path, ignore_errors=True)
        except Exception:
            pass

    return result


async def _send_reply(page, reply_text: str, profile_name: str):
    """Type and send a reply in the currently open thread."""
    try:
        input_box = page.locator(".msg-form__contenteditable").first
        await input_box.wait_for(timeout=10000)
        await input_box.click()
        await input_box.fill(reply_text)
        await page.wait_for_timeout(500)

        # Try send button first, fallback to Enter
        send_btn = page.locator("button.msg-form__send-button").first
        send_count = await send_btn.count()
        if send_count > 0:
            await send_btn.click()
        else:
            await input_box.press("Enter")

        await page.wait_for_timeout(2000)
        log.info(f"[{profile_name}] Reply sent successfully")
    except Exception as e:
        log.error(f"[{profile_name}] Failed to send reply: {e}")
        raise


# ── Main ──────────────────────────────────────────────────────────────────────

async def run(args):
    # Determine which profiles to process
    if args.profile:
        profiles = [args.profile]
    else:
        profiles = discover_profiles()

    log.info(f"Profiles to process: {profiles}")

    status_map = {}
    all_results = []
    timestamp = datetime.now().strftime("%Y%m%dT%H%M%S")

    for i, profile_name in enumerate(profiles):
        if i > 0:
            await asyncio.sleep(3)  # Rate-limit between profiles

        reply_args = None
        if args.reply:
            if not args.conversation_id or not args.text:
                log.error("--reply requires --conversation-id and --text")
                sys.exit(1)
            reply_args = {"conversation_id": args.conversation_id, "text": args.text}

        try:
            result = await scrape_profile(profile_name, reply_args=reply_args)
            all_results.append(result)
            status_map[profile_name] = result["status"]

            if not args.reply:
                # Write per-profile JSON
                safe_name = profile_name.replace(" ", "")
                out_path = f"{OUTPUT_DIR}/linkedin_inbox_{safe_name}_{timestamp}.json"
                with open(out_path, "w") as f:
                    json.dump(result, f, indent=2, ensure_ascii=False)
                log.info(f"Results written to {out_path}")

                unread_count = sum(1 for c in result["conversations"] if c.get("unread"))
                total = len(result["conversations"])
                print(f"[{profile_name}] {result['account_name']} — {total} conversations scraped, {unread_count} unread")
                print(f"Results written to {out_path}")
        except Exception as e:
            log.error(f"Profile {profile_name} failed: {e}")
            status_map[profile_name] = "error"

    # Write status summary
    status_path = f"{OUTPUT_DIR}/linkedin_status.json"
    with open(status_path, "w") as f:
        json.dump({"timestamp": timestamp, "profiles": status_map}, f, indent=2)
    log.info(f"Status written to {status_path}")

    return all_results


def main():
    parser = argparse.ArgumentParser(description="LinkedIn inbox reader — multi-profile Playwright")
    parser.add_argument("--profile", help="Chromium profile name (e.g. 'Default', 'Profile 1'). Omit to run all.")
    parser.add_argument("--reply", action="store_true", help="Send a reply instead of scraping")
    parser.add_argument("--conversation-id", dest="conversation_id", help="Thread ID to reply to")
    parser.add_argument("--text", help="Reply text")
    args = parser.parse_args()

    asyncio.run(run(args))


if __name__ == "__main__":
    main()
