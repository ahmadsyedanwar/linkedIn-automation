import fs from "fs";
import { LOG_FILE } from "./config.js";

const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function format(level: string, msg: string): string {
  return `${new Date().toISOString()} [${level}] ${msg}`;
}

export const log = {
  info(msg: string) {
    const line = format("INFO", msg);
    console.log(line);
    logStream.write(line + "\n");
  },
  warning(msg: string) {
    const line = format("WARNING", msg);
    console.log(line);
    logStream.write(line + "\n");
  },
  error(msg: string) {
    const line = format("ERROR", msg);
    console.error(line);
    logStream.write(line + "\n");
  },
};
