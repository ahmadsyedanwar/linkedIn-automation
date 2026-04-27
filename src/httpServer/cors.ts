/** CORS for JSON API + optional preflight. */
export const CORS_JSON_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
} as const;

export const CORS_ALL_METHODS = {
  ...CORS_JSON_HEADERS,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
} as const;

export function writeOptionsCorsNoContent(
  res: import("http").ServerResponse
): void {
  res.writeHead(204, CORS_ALL_METHODS);
  res.end();
}
