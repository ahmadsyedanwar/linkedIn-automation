import fs from "fs";
import { formatLogLine, type LogLevelName } from "./formatLogLine.js";

export type Logger = {
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
};

function createLineWriter(logFilePath: string) {
  const stream = fs.createWriteStream(logFilePath, { flags: "a" });
  return (line: string) => {
    stream.write(`${line}\n`);
  };
}

function emit(
  level: LogLevelName,
  message: string,
  writeLine: (line: string) => void,
  print: (line: string) => void
): void {
  const line = formatLogLine(level, message);
  print(line);
  writeLine(line);
}

/**
 * Console + append-only file logger with ISO timestamps and levels.
 */
export function createFileLogger(logFilePath: string): Logger {
  const writeLine = createLineWriter(logFilePath);
  return {
    info(msg: string) {
      emit("INFO", msg, writeLine, console.log);
    },
    warning(msg: string) {
      emit("WARNING", msg, writeLine, console.log);
    },
    error(msg: string) {
      emit("ERROR", msg, writeLine, console.error);
    },
  };
}
