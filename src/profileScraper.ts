#!/usr/bin/env node
/**
 * profileScraper.ts — Scrape a LinkedIn connection's profile for bio summary.
 *
 * Usage:
 *   npx ts-node src/profileScraper.ts --url "https://www.linkedin.com/in/username" --profile Default
 *   npx ts-node src/profileScraper.ts --inbox-json /tmp/linkedin_inbox_Default_*.json --thread-id THREAD_ID
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import {
  CHROME_EXECUTABLE,
  CHROME_USER_DATA,
  OUTPUT_DIR,
  CHROME_ARGS,
} from "./config.js";
import { log } from "./logger.js";
import type {
  ProfileResult,
  RawProfileData,
  InboxResult,
} from "./types.js";

function isLoggedIn(url: string): boolean {
  return !url.includes("/login") && !url.includes("/checkpoint") && !url.includes("/uas/");
}

function findProfileUrlFromInbox(inboxJsonPath: string, threadId: string): string | null {
  const data: InboxResult = JSON.parse(fs.readFileSync(inboxJsonPath, "utf-8"));
  for (const conv of data.conversations ?? []) {
    if (conv.conversation_id === threadId) {
      if (conv.sender_profile_url) return conv.sender_profile_url;
      for (const msg of conv.messages ?? []) {
        if (msg.sender_profile_url && msg.direction === "incoming") {
          return msg.sender_profile_url;
        }
      }
    }
  }
  return null;
}

async function scrapeLinkedinProfile(
  profileName: string,
  linkedinUrl: string
): Promise<ProfileResult> {
  const result: ProfileResult = {
    scraped_at: new Date().toISOString(),
    profile_url: linkedinUrl,
    chromium_profile: profileName,
    status: "ok",
    name: "",
    headline: "",
    location: "",
    about: "",
    current_company: "",
    current_title: "",
    experience: [],
    education: [],
    connection_degree: "",
  };

  try {
    const browser = await chromium.launchPersistentContext(CHROME_USER_DATA, {
      headless: true,
      executablePath: CHROME_EXECUTABLE,
      args: [...CHROME_ARGS, `--profile-directory=${profileName}`],
    });

    const page = browser.pages()[0] ?? (await browser.newPage());

    log.info(`Navigating to ${linkedinUrl}`);
    await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(7000);

    if (!isLoggedIn(page.url())) {
      result.status = "not_logged_in";
      log.warning(`[${profileName}] Not logged in`);
      await browser.close();
      return result;
    }

    // Scroll to trigger lazy section rendering
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await page.waitForTimeout(1000);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    const data = await page.evaluate((): RawProfileData => {
      const body = (document.body as HTMLElement).innerText;

      const headings = Array.from(document.querySelectorAll<HTMLElement>('[role="heading"], h1, h2'));
      let name = "";
      for (const h of headings) {
        const t = h.innerText.trim();
        if (t && !t.includes("notification") && !t.includes("Skip") && t.length > 1 && t.length < 80) {
          name = t;
          break;
        }
      }

      let headline = "";
      let location = "";
      let about = "";
      let connectionDegree = "";

      const lines = body.split("\n").map((l) => l.trim()).filter((l) => l);

      let nameIdx = -1;
      let firstFound = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === name) {
          if (firstFound) { nameIdx = i; break; }
          firstFound = true;
        }
      }
      if (nameIdx < 0) nameIdx = lines.findIndex((l) => l === name);

      if (nameIdx >= 0) {
        let cursor = nameIdx + 1;

        if (cursor < lines.length && /^·\s*(1st|2nd|3rd)/.test(lines[cursor])) {
          connectionDegree = lines[cursor].replace("·", "").trim();
          cursor++;
        }

        if (cursor < lines.length && !lines[cursor].includes("Contact info") && lines[cursor] !== "More") {
          headline = lines[cursor];
          cursor++;
        }

        const skipWords = new Set(["More", "Message", "Follow", "Connect", "Visit my website", "·"]);
        while (cursor < lines.length && cursor < nameIdx + 10) {
          const line = lines[cursor];
          if (line.includes("Contact info")) break;
          if (line.includes("followers") || line.includes("connections")) break;
          if (!skipWords.has(line) && line.length > 3 && line.length < 60
            && !line.startsWith("Visit") && !line.startsWith("http")) {
            location = line;
            break;
          }
          cursor++;
        }
      }

      const aboutIdx = lines.findIndex((l) => l === "About");
      if (aboutIdx >= 0) {
        const aboutLines: string[] = [];
        const stopSections = new Set(["Activity", "Experience", "Education", "Services", "Featured", "Skills", "Recommendations"]);
        for (let i = aboutIdx + 1; i < lines.length && i < aboutIdx + 20; i++) {
          if (stopSections.has(lines[i])) break;
          if (lines[i] === "…see more") continue;
          aboutLines.push(lines[i]);
        }
        about = aboutLines.join(" ").trim();
      }

      const experience: RawProfileData["experience"] = [];
      const expIdx = lines.findIndex((l) => l === "Experience");
      if (expIdx >= 0) {
        let i = expIdx + 1;
        let entries = 0;
        const expStop = new Set(["Education", "Skills", "Recommendations", "Interests", "Licenses", "Certifications", "Projects", "Honors", "Languages", "Volunteer"]);
        while (i < lines.length && entries < 5) {
          if (expStop.has(lines[i])) break;
          const entry = { title: "", company: "", duration: "", location: "" };
          const chunk: string[] = [];
          const chunkStop = new Set(["Education", "Skills", "Recommendations", "Interests", "Licenses"]);
          while (i < lines.length && chunk.length < 8) {
            if (chunkStop.has(lines[i])) break;
            chunk.push(lines[i]);
            i++;
            if (chunk.length >= 2 && /\d{4}|Present|·/.test(chunk[chunk.length - 1])) break;
          }
          if (chunk.length >= 2) {
            entry.title = chunk[0] ?? "";
            entry.company = chunk[1] ?? "";
            entry.duration = chunk[2] ?? "";
            entry.location = chunk[3] ?? "";
            experience.push(entry);
            entries++;
          }
        }
      }

      const education: RawProfileData["education"] = [];
      const eduIdx = lines.findIndex((l) => l === "Education");
      if (eduIdx >= 0) {
        let i = eduIdx + 1;
        let entries = 0;
        const eduStop = new Set(["Skills", "Recommendations", "Interests", "Licenses", "Experience", "Certifications", "Projects"]);
        while (i < lines.length && entries < 3) {
          if (eduStop.has(lines[i])) break;
          const entry = { school: "", degree: "", years: "" };
          const chunk: string[] = [];
          const chunkStop = new Set(["Skills", "Recommendations", "Interests", "Licenses"]);
          while (i < lines.length && chunk.length < 5) {
            if (chunkStop.has(lines[i])) break;
            chunk.push(lines[i]);
            i++;
            if (chunk.length >= 2 && /\d{4}/.test(chunk[chunk.length - 1])) break;
          }
          if (chunk.length >= 1) {
            entry.school = chunk[0] ?? "";
            entry.degree = chunk[1] ?? "";
            entry.years = chunk[2] ?? "";
            education.push(entry);
            entries++;
          }
        }
      }

      const currentTitle = experience.length > 0 ? experience[0].title : "";
      const currentCompany = experience.length > 0 ? experience[0].company : "";

      return { name, headline, location, connectionDegree, about, experience, education, currentTitle, currentCompany };
    });

    result.name = data.name ?? "";
    result.headline = data.headline ?? "";
    result.location = data.location ?? "";
    result.connection_degree = data.connectionDegree ?? "";
    result.about = data.about ?? "";
    result.current_title = data.currentTitle ?? "";
    result.current_company = data.currentCompany ?? "";
    result.experience = data.experience ?? [];
    result.education = data.education ?? [];

    const safeName = result.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 20) || "unknown";
    await page.screenshot({ path: `/tmp/linkedin_bio_${safeName}.png` });

    log.info(`Scraped profile: ${result.name} — ${result.headline.slice(0, 60)}`);
    await browser.close();
  } catch (e) {
    log.error(`Fatal error scraping ${linkedinUrl}: ${e}`);
    result.status = "error";
    result.error = String(e);
  }

  return result;
}

function generateBioSummary(profile: ProfileResult): string {
  const lines: string[] = [];
  lines.push(`## ${profile.name}`);
  if (profile.headline) lines.push(`**${profile.headline}**`);
  if (profile.location) lines.push(`📍 ${profile.location}`);
  if (profile.connection_degree) lines.push(`🔗 ${profile.connection_degree} connection`);
  lines.push("");

  if (profile.about) {
    lines.push("### About");
    lines.push(profile.about.slice(0, 500));
    lines.push("");
  }

  if (profile.experience.length > 0) {
    lines.push("### Experience");
    for (const exp of profile.experience.slice(0, 5)) {
      const dur = exp.duration ? ` (${exp.duration})` : "";
      if (exp.title || exp.company) {
        lines.push(`- **${exp.title}** at ${exp.company}${dur}`);
      }
    }
    lines.push("");
  }

  if (profile.education.length > 0) {
    lines.push("### Education");
    for (const edu of profile.education.slice(0, 3)) {
      if (edu.school) {
        const deg = edu.degree ? ` — ${edu.degree}` : "";
        const yr = edu.years ? ` (${edu.years})` : "";
        lines.push(`- ${edu.school}${deg}${yr}`);
      }
    }
  }

  return lines.join("\n");
}

async function mainAsync(args: {
  profile: string;
  url?: string;
  inboxJson?: string;
  threadId?: string;
}): Promise<ProfileResult> {
  const profileName = args.profile;

  let linkedinUrl = args.url;
  if (!linkedinUrl && args.inboxJson && args.threadId) {
    linkedinUrl = findProfileUrlFromInbox(args.inboxJson, args.threadId) ?? undefined;
    if (!linkedinUrl) {
      log.error(`Could not find profile URL for thread ${args.threadId} in ${args.inboxJson}`);
      process.exit(1);
    }
  }

  if (!linkedinUrl) {
    log.error("Must provide --url or --inbox-json + --thread-id");
    process.exit(1);
  }

  if (!linkedinUrl.startsWith("http")) {
    linkedinUrl = `https://www.linkedin.com${linkedinUrl}`;
  }

  log.info(`Scraping profile: ${linkedinUrl} using ${profileName}`);
  const result = await scrapeLinkedinProfile(profileName, linkedinUrl);

  const safeName = result.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30) || "unknown";
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "T");
  const outPath = path.join(OUTPUT_DIR, `linkedin_bio_${safeName}_${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");
  log.info(`Bio JSON written to ${outPath}`);

  const summary = generateBioSummary(result);
  console.log(summary);
  console.log(`\nJSON: ${outPath}`);

  return result;
}

function main() {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      profile: { type: "string", default: "Default" },
      "inbox-json": { type: "string" },
      "thread-id": { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  mainAsync({
    profile: (values.profile as string) ?? "Default",
    url: values.url as string | undefined,
    inboxJson: values["inbox-json"] as string | undefined,
    threadId: values["thread-id"] as string | undefined,
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

main();
