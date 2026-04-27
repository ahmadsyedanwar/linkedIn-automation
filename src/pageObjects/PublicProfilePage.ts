import path from "path";
import type { Page } from "playwright";
import { OUTPUT_DIR } from "../config.js";
import { log } from "../logger.js";
import type { RawProfileData } from "../types.js";
import { LinkedInBasePage } from "./LinkedInBasePage.js";

/**
 * Page object for a LinkedIn /in/ public profile (bio scrape).
 */
export class PublicProfilePage extends LinkedInBasePage {
  constructor(page: Page) {
    super(page);
  }

  async gotoProfile(linkedinUrl: string): Promise<void> {
    log.info(`Navigating to ${linkedinUrl}`);
    await this.page.goto(linkedinUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await this.page.waitForTimeout(7000);
  }

  async scrollToLoadLazySections(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      await this.page.evaluate(() => window.scrollBy(0, 600));
      await this.page.waitForTimeout(1000);
    }
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await this.page.waitForTimeout(1000);
  }

  async extractProfileDom(): Promise<RawProfileData> {
    return this.page.evaluate((): RawProfileData => {
      const body = (document.body as HTMLElement).innerText;
      const headings = Array.from(
        document.querySelectorAll<HTMLElement>('[role="heading"], h1, h2')
      );
      let name = "";
      for (const h of headings) {
        const t = h.innerText.trim();
        if (
          t &&
          !t.includes("notification") &&
          !t.includes("Skip") &&
          t.length > 1 &&
          t.length < 80
        ) {
          name = t;
          break;
        }
      }
      let headline = "";
      let location = "";
      let about = "";
      let connectionDegree = "";
      const lines = body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l);
      let nameIdx = -1;
      let firstFound = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === name) {
          if (firstFound) {
            nameIdx = i;
            break;
          }
          firstFound = true;
        }
      }
      if (nameIdx < 0) nameIdx = lines.findIndex((l) => l === name);
      if (nameIdx >= 0) {
        let cursor = nameIdx + 1;
        if (
          cursor < lines.length &&
          /^·\s*(1st|2nd|3rd)/.test(lines[cursor])
        ) {
          connectionDegree = lines[cursor].replace("·", "").trim();
          cursor++;
        }
        if (
          cursor < lines.length &&
          !lines[cursor].includes("Contact info") &&
          lines[cursor] !== "More"
        ) {
          headline = lines[cursor];
          cursor++;
        }
        const skipWords = new Set([
          "More",
          "Message",
          "Follow",
          "Connect",
          "Visit my website",
          "·",
        ]);
        while (cursor < lines.length && cursor < nameIdx + 10) {
          const line = lines[cursor];
          if (line.includes("Contact info")) break;
          if (line.includes("followers") || line.includes("connections")) {
            break;
          }
          if (
            !skipWords.has(line) &&
            line.length > 3 &&
            line.length < 60 &&
            !line.startsWith("Visit") &&
            !line.startsWith("http")
          ) {
            location = line;
            break;
          }
          cursor++;
        }
      }
      const aboutIdx = lines.findIndex((l) => l === "About");
      if (aboutIdx >= 0) {
        const aboutLines: string[] = [];
        const stopSections = new Set([
          "Activity",
          "Experience",
          "Education",
          "Services",
          "Featured",
          "Skills",
          "Recommendations",
        ]);
        for (
          let i = aboutIdx + 1;
          i < lines.length && i < aboutIdx + 20;
          i++
        ) {
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
        const expStop = new Set([
          "Education",
          "Skills",
          "Recommendations",
          "Interests",
          "Licenses",
          "Certifications",
          "Projects",
          "Honors",
          "Languages",
          "Volunteer",
        ]);
        while (i < lines.length && entries < 5) {
          if (expStop.has(lines[i])) break;
          const entry = {
            title: "",
            company: "",
            duration: "",
            location: "",
          };
          const chunk: string[] = [];
          const chunkStop = new Set([
            "Education",
            "Skills",
            "Recommendations",
            "Interests",
            "Licenses",
          ]);
          while (i < lines.length && chunk.length < 8) {
            if (chunkStop.has(lines[i])) break;
            chunk.push(lines[i]);
            i++;
            if (chunk.length >= 2 && /\d{4}|Present|·/.test(chunk[chunk.length - 1])) {
              break;
            }
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
        const eduStop = new Set([
          "Skills",
          "Recommendations",
          "Interests",
          "Licenses",
          "Experience",
          "Certifications",
          "Projects",
        ]);
        while (i < lines.length && entries < 3) {
          if (eduStop.has(lines[i])) break;
          const entry = { school: "", degree: "", years: "" };
          const chunk: string[] = [];
          const chunkStop = new Set([
            "Skills",
            "Recommendations",
            "Interests",
            "Licenses",
          ]);
          while (i < lines.length && chunk.length < 5) {
            if (chunkStop.has(lines[i])) break;
            chunk.push(lines[i]);
            i++;
            if (chunk.length >= 2 && /\d{4}/.test(chunk[chunk.length - 1])) {
              break;
            }
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
      return {
        name,
        headline,
        location,
        connectionDegree,
        about,
        experience,
        education,
        currentTitle,
        currentCompany,
      };
    });
  }

  async takeProfileScreenshot(safeName: string): Promise<void> {
    await this.page.screenshot({
      path: path.join(OUTPUT_DIR, `linkedin_bio_${safeName}.png`),
    });
  }
}
