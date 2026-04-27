import { OUTPUT_DIR } from "../config.js";

const DEFAULT_PORT = 9000;

export function getServerPort(): number {
  return parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
}

export function getApiToken(): string {
  return process.env.LINKEDIN_API_TOKEN ?? "";
}

export function getWebhookUrl(): string {
  return process.env.LINKEDIN_WEBHOOK_URL ?? "";
}

export { OUTPUT_DIR as outputDir };
