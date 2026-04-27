import type { ServerResponse } from "http";
import type { ApiResponse } from "../types.js";
import { CORS_JSON_HEADERS } from "./cors.js";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  ...CORS_JSON_HEADERS,
} as const;

export function writeJsonResponse<T>(
  res: ServerResponse,
  status: number,
  body: ApiResponse<T>
): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body, null, 2));
}

export function sendOk<T>(res: ServerResponse, data: T): void {
  writeJsonResponse(res, 200, {
    ok: true,
    data,
    timestamp: new Date().toISOString(),
  });
}

export function sendError(
  res: ServerResponse,
  status: number,
  message: string
): void {
  writeJsonResponse(res, status, {
    ok: false,
    error: message,
    timestamp: new Date().toISOString(),
  });
}
