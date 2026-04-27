import { URL } from "url";
import type { RequestOptions } from "http";
import http from "http";
import { log } from "../logger.js";

export async function postJsonWebhook(
  webhookUrl: string,
  payload: unknown
): Promise<void> {
  if (!webhookUrl) return;
  try {
    const u = new URL(webhookUrl);
    const body = JSON.stringify(payload);
    const options: RequestOptions = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      },
    };
    await new Promise<void>((resolve) => {
      const req = http.request(options, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", (e) => {
        log.warning(`Webhook fire failed: ${(e as Error).message}`);
        resolve();
      });
      req.write(body);
      req.end();
    });
    log.info(`Webhook fired to ${webhookUrl}`);
  } catch (e) {
    log.warning(`Webhook error: ${e}`);
  }
}
