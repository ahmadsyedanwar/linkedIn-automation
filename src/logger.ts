import { LOG_FILE } from "./config.js";
import { createFileLogger } from "./logging/createFileLogger.js";

/**
 * App-wide logger: console + `LOG_FILE` (see `config.ts`).
 * Implementation lives in `src/logging/`.
 */
export const log = createFileLogger(LOG_FILE);
