// Centralized logger for consistent, controllable logging across the extension.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const PREFIX = "[FreeLens AI]";

let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function getLogLevel(): LogLevel {
  return minLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

export const logger = {
  debug(...args: unknown[]): void {
    if (shouldLog("debug")) console.debug(PREFIX, ...args);
  },
  info(...args: unknown[]): void {
    if (shouldLog("info")) console.log(PREFIX, ...args);
  },
  warn(...args: unknown[]): void {
    if (shouldLog("warn")) console.warn(PREFIX, ...args);
  },
  error(...args: unknown[]): void {
    if (shouldLog("error")) console.error(PREFIX, ...args);
  },
};
