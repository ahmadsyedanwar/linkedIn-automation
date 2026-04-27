import type { IncomingMessage } from "http";

export function readJsonBody(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}") as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}
