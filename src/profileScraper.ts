#!/usr/bin/env node
/**
 * profileScraper.ts — Scrape a LinkedIn connection's profile for bio summary.
 *
 * Usage:
 *   npx ts-node src/profileScraper.ts --url "https://www.linkedin.com/in/username" --profile Default
 *   npx ts-node src/profileScraper.ts --inbox-json /tmp/linkedin_inbox_Default_*.json --thread-id THREAD_ID
 */

import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import { OUTPUT_DIR } from "./config.js";
import { log } from "./logger.js";
import {
  getOrCreateFirstPage,
  launchChromiumForProfile,
  PublicProfilePage,
} from "./pageObjects/index.js";
import type { InboxResult, ProfileResult } from "./types.js";

function findProfileUrlFromInbox(
  inboxJsonPath: string,
  threadId: string
): string | null {
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
  // —— Arrange
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

  let browser: Awaited<ReturnType<typeof launchChromiumForProfile>> | null =
    null;

  try {
    // —— Act
    browser = await launchChromiumForProfile(profileName);
    const page = await getOrCreateFirstPage(browser);
    const profile = new PublicProfilePage(page);
    await profile.gotoProfile(linkedinUrl);

    // —— Assert
    if (!profile.isLoggedIn()) {
      result.status = "not_logged_in";
      log.warning(`[${profileName}] Not logged in`);
      return result;
    }

    await profile.scrollToLoadLazySections();
    const data = await profile.extractProfileDom();
    result.name = data.name ?? "";
    result.headline = data.headline ?? "";
    result.location = data.location ?? "";
    result.connection_degree = data.connectionDegree ?? "";
    result.about = data.about ?? "";
    result.current_title = data.currentTitle ?? "";
    result.current_company = data.currentCompany ?? "";
    result.experience = data.experience ?? [];
    result.education = data.education ?? [];

    const safeName =
      result.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 20) || "unknown";
    await profile.takeProfileScreenshot(safeName);
    log.info(
      `Scraped profile: ${result.name} — ${result.headline.slice(0, 60)}`
    );
  } catch (e) {
    log.error(`Fatal error scraping ${linkedinUrl}: ${e}`);
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
  }
  return result;
}

function generateBioSummary(profile: ProfileResult): string {
  const lines: string[] = [];
  lines.push(`## ${profile.name}`);
  if (profile.headline) lines.push(`**${profile.headline}**`);
  if (profile.location) lines.push(`📍 ${profile.location}`);
  if (profile.connection_degree) {
    lines.push(`🔗 ${profile.connection_degree} connection`);
  }
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
      log.error(
        `Could not find profile URL for thread ${args.threadId} in ${args.inboxJson}`
      );
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

  const safeName =
    result.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30) || "unknown";
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "T");
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
