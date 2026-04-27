export type LogLevelName = "INFO" | "WARNING" | "ERROR";

export function formatLogLine(level: LogLevelName, message: string): string {
  return `${new Date().toISOString()} [${level}] ${message}`;
}
