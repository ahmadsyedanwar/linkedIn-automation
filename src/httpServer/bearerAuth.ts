import type { IncomingMessage } from "http";

/**
 * If `apiToken` is empty, all requests are allowed (dev). Otherwise require
 * `Authorization: Bearer <token>`.
 */
export function isRequestAuthorized(
  req: IncomingMessage,
  apiToken: string
): boolean {
  if (!apiToken) return true;
  const auth = req.headers["authorization"] ?? "";
  return auth === `Bearer ${apiToken}`;
}
