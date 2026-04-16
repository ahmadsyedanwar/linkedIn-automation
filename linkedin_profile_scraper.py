#!/usr/bin/env python3
"""
linkedin_profile_scraper.py — Scrape a LinkedIn connection's profile for bio summary.

Given a profile URL (or conversation thread ID + profile name from inbox JSON),
scrapes: name, headline, location, current company/title, experience, education,
about section. Outputs a JSON bio summary that AI can use to generate personalized replies.

Usage:
  python3 linkedin_profile_scraper.py --url "https://www.linkedin.com/in/username" --profile Default
  python3 linkedin_profile_scraper.py --inbox-json /tmp/linkedin_inbox_Default_*.json --thread-id THREAD_ID
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
OUTPUT_DIR         = "/tmp"
LOG_FILE           = "/tmp/linkedin_profile_scraper.log"

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


def is_logged_in(url: str) -> bool:
    return "/login" not in url and "/checkpoint" not in url and "/uas/" not in url


def find_profile_url_from_inbox(inbox_json_path: str, thread_id: str) -> str | None:
    """Look up a sender_profile_url from an inbox JSON file by thread ID."""
    with open(inbox_json_path) as f:
        data = json.load(f)
    for conv in data.get("conversations", []):
        if conv.get("conversation_id") == thread_id:
            url = conv.get("sender_profile_url", "")
            if url:
                return url
            # Try to find from messages
            for msg in conv.get("messages", []):
                url = msg.get("sender_profile_url", "")
                if url and msg.get("direction") == "incoming":
                    return url
    return None


async def scrape_linkedin_profile(profile_name: str, linkedin_url: str) -> dict:
    """Scrape a LinkedIn profile page for bio information."""
    result = {
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "profile_url": linkedin_url,
        "chromium_profile": profile_name,
        "status": "ok",
        "name": "",
        "headline": "",
        "location": "",
        "about": "",
        "current_company": "",
        "current_title": "",
        "experience": [],
        "education": [],
        "connection_degree": "",
    }

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

            log.info(f"Navigating to {linkedin_url}")
            await page.goto(linkedin_url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(7000)

            if not is_logged_in(page.url):
                result["status"] = "not_logged_in"
                log.warning(f"[{profile_name}] Not logged in")
                await browser.close()
                return result

            # Scroll to trigger lazy section rendering
            for _ in range(4):
                await page.evaluate("window.scrollBy(0, 600)")
                await page.wait_for_timeout(1000)
            await page.evaluate("window.scrollTo(0, 0)")
            await page.wait_for_timeout(1000)

            # ── Extract all data via JS using innerText parsing ───────────────
            data = await page.evaluate("""
                () => {
                    const body = document.body.innerText;
                    const html = document.body.innerHTML;
                    
                    // Name: second h2-role heading (first is notification count)
                    const headings = document.querySelectorAll('[role="heading"], h1, h2');
                    let name = '';
                    for (const h of headings) {
                        const t = h.innerText.trim();
                        if (t && !t.includes('notification') && !t.includes('Skip') && t.length > 1 && t.length < 80) {
                            name = t;
                            break;
                        }
                    }
                    
                    // Headline: text immediately after the name in the page content
                    let headline = '';
                    let location = '';
                    let about = '';
                    let connectionDegree = '';
                    
                    // Parse structured data from body text
                    const lines = body.split('\\n').map(l => l.trim()).filter(l => l);
                    
                    // Find the SECOND occurrence of the name (the detailed profile section)
                    let nameIdx = -1;
                    let firstFound = false;
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i] === name) {
                            if (firstFound) { nameIdx = i; break; }
                            firstFound = true;
                        }
                    }
                    // Fallback to first if second not found
                    if (nameIdx < 0) nameIdx = lines.findIndex(l => l === name);
                    
                    if (nameIdx >= 0) {
                        let cursor = nameIdx + 1;
                        
                        // Check for connection degree (· 1st, · 2nd, etc)
                        if (cursor < lines.length && /^·\\s*(1st|2nd|3rd)/.test(lines[cursor])) {
                            connectionDegree = lines[cursor].replace('·', '').trim();
                            cursor++;
                        }
                        
                        // Headline (next line)
                        if (cursor < lines.length && !lines[cursor].includes('Contact info') && lines[cursor] !== 'More') {
                            headline = lines[cursor];
                            cursor++;
                        }
                        
                        // Location: scan forward for the line before "Contact info" or "·"
                        // Skip action buttons and short markers
                        const skipWords = new Set(['More', 'Message', 'Follow', 'Connect', 'Visit my website', '·']);
                        while (cursor < lines.length && cursor < nameIdx + 10) {
                            const line = lines[cursor];
                            if (line.includes('Contact info')) break;
                            if (line.includes('followers') || line.includes('connections')) break;
                            if (!skipWords.has(line) && line.length > 3 && line.length < 60 
                                && !line.startsWith('Visit') && !line.startsWith('http')) {
                                location = line;
                                break;
                            }
                            cursor++;
                        }
                    }
                    
                    // About section
                    const aboutIdx = lines.findIndex(l => l === 'About');
                    if (aboutIdx >= 0) {
                        let aboutLines = [];
                        for (let i = aboutIdx + 1; i < lines.length && i < aboutIdx + 20; i++) {
                            if (['Activity', 'Experience', 'Education', 'Services', 'Featured', 'Skills', 'Recommendations'].includes(lines[i])) break;
                            if (lines[i] === '…see more') continue;
                            aboutLines.push(lines[i]);
                        }
                        about = aboutLines.join(' ').trim();
                    }
                    
                    // Experience section
                    const experience = [];
                    const expIdx = lines.findIndex(l => l === 'Experience');
                    if (expIdx >= 0) {
                        let i = expIdx + 1;
                        let entries = 0;
                        while (i < lines.length && entries < 5) {
                            if (['Education', 'Skills', 'Recommendations', 'Interests', 'Licenses', 'Certifications', 'Projects', 'Honors', 'Languages', 'Volunteer'].includes(lines[i])) break;
                            // An experience entry typically has: Logo, Title, Company, Duration, Location
                            // Look for patterns with time ranges (e.g., "Jan 2020 - Present")
                            const entry = {title: '', company: '', duration: '', location: ''};
                            // Collect until next entry or section
                            let chunk = [];
                            while (i < lines.length && chunk.length < 8) {
                                if (['Education', 'Skills', 'Recommendations', 'Interests', 'Licenses'].includes(lines[i])) break;
                                chunk.push(lines[i]);
                                i++;
                                // If we hit a line with a date range pattern, that usually ends an entry
                                if (chunk.length >= 2 && /\\d{4}|Present|·/.test(chunk[chunk.length - 1])) {
                                    break;
                                }
                            }
                            if (chunk.length >= 2) {
                                entry.title = chunk[0] || '';
                                entry.company = chunk.length > 1 ? chunk[1] : '';
                                entry.duration = chunk.length > 2 ? chunk[2] : '';
                                entry.location = chunk.length > 3 ? chunk[3] : '';
                                experience.push(entry);
                                entries++;
                            }
                        }
                    }
                    
                    // Education
                    const education = [];
                    const eduIdx = lines.findIndex(l => l === 'Education');
                    if (eduIdx >= 0) {
                        let i = eduIdx + 1;
                        let entries = 0;
                        while (i < lines.length && entries < 3) {
                            if (['Skills', 'Recommendations', 'Interests', 'Licenses', 'Experience', 'Certifications', 'Projects'].includes(lines[i])) break;
                            const entry = {school: '', degree: '', years: ''};
                            let chunk = [];
                            while (i < lines.length && chunk.length < 5) {
                                if (['Skills', 'Recommendations', 'Interests', 'Licenses'].includes(lines[i])) break;
                                chunk.push(lines[i]);
                                i++;
                                if (chunk.length >= 2 && /\\d{4}/.test(chunk[chunk.length - 1])) break;
                            }
                            if (chunk.length >= 1) {
                                entry.school = chunk[0] || '';
                                entry.degree = chunk.length > 1 ? chunk[1] : '';
                                entry.years = chunk.length > 2 ? chunk[2] : '';
                                education.push(entry);
                                entries++;
                            }
                        }
                    }
                    
                    // Current company & title
                    const currentTitle = experience.length > 0 ? experience[0].title : '';
                    const currentCompany = experience.length > 0 ? experience[0].company : '';
                    
                    return {name, headline, location, connectionDegree, about, experience, education, currentTitle, currentCompany};
                }
            """)

            result["name"] = data.get("name", "")
            result["headline"] = data.get("headline", "")
            result["location"] = data.get("location", "")
            result["connection_degree"] = data.get("connectionDegree", "")
            result["about"] = data.get("about", "")
            result["current_title"] = data.get("currentTitle", "")
            result["current_company"] = data.get("currentCompany", "")
            result["experience"] = data.get("experience", [])
            result["education"] = data.get("education", [])

            # Take a screenshot for debugging
            safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', result["name"])[:20] or "unknown"
            await page.screenshot(path=f"/tmp/linkedin_bio_{safe_name}.png")

            log.info(f"Scraped profile: {result['name']} — {result['headline'][:60]}")
            await browser.close()

    except Exception as e:
        log.error(f"Fatal error scraping {linkedin_url}: {e}")
        result["status"] = "error"
        result["error"] = str(e)

    return result


def generate_bio_summary(profile: dict) -> str:
    """Generate a human-readable bio summary from scraped profile data."""
    lines = []
    lines.append(f"## {profile['name']}")
    if profile.get("headline"):
        lines.append(f"**{profile['headline']}**")
    if profile.get("location"):
        lines.append(f"📍 {profile['location']}")
    if profile.get("connection_degree"):
        lines.append(f"🔗 {profile['connection_degree']} connection")
    lines.append("")

    if profile.get("about"):
        lines.append("### About")
        lines.append(profile["about"][:500])
        lines.append("")

    if profile.get("experience"):
        lines.append("### Experience")
        for exp in profile["experience"][:5]:
            title = exp.get("title", "")
            company = exp.get("company", "")
            duration = exp.get("duration", "")
            if title or company:
                lines.append(f"- **{title}** at {company}" + (f" ({duration})" if duration else ""))
        lines.append("")

    if profile.get("education"):
        lines.append("### Education")
        for edu in profile["education"][:3]:
            school = edu.get("school", "")
            degree = edu.get("degree", "")
            years = edu.get("years", "")
            if school:
                lines.append(f"- {school}" + (f" — {degree}" if degree else "") + (f" ({years})" if years else ""))

    return "\n".join(lines)


async def main_async(args):
    profile_name = args.profile or "Default"

    # Resolve the LinkedIn URL
    linkedin_url = args.url
    if not linkedin_url and args.inbox_json and args.thread_id:
        linkedin_url = find_profile_url_from_inbox(args.inbox_json, args.thread_id)
        if not linkedin_url:
            log.error(f"Could not find profile URL for thread {args.thread_id} in {args.inbox_json}")
            sys.exit(1)

    if not linkedin_url:
        log.error("Must provide --url or --inbox-json + --thread-id")
        sys.exit(1)

    # Normalize URL
    if not linkedin_url.startswith("http"):
        linkedin_url = f"https://www.linkedin.com{linkedin_url}"

    log.info(f"Scraping profile: {linkedin_url} using {profile_name}")
    result = await scrape_linkedin_profile(profile_name, linkedin_url)

    # Write JSON output
    safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', result["name"])[:30] or "unknown"
    timestamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    out_path = f"{OUTPUT_DIR}/linkedin_bio_{safe_name}_{timestamp}.json"
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    log.info(f"Bio JSON written to {out_path}")

    # Print summary
    summary = generate_bio_summary(result)
    print(summary)
    print(f"\nJSON: {out_path}")

    return result


def main():
    parser = argparse.ArgumentParser(description="LinkedIn connection profile scraper")
    parser.add_argument("--url", help="LinkedIn profile URL to scrape")
    parser.add_argument("--profile", default="Default", help="Chromium profile name (default: Default)")
    parser.add_argument("--inbox-json", dest="inbox_json", help="Path to inbox JSON to look up profile URL by thread ID")
    parser.add_argument("--thread-id", dest="thread_id", help="Conversation thread ID (used with --inbox-json)")
    args = parser.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
