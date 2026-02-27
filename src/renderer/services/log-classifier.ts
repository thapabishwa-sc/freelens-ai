import type { StoredPattern } from "./pattern-storage";
import { safeRegex, safeRegexTest } from "../utils/safe-regex";

export interface LogViewerConfig {
  classifyLine: (text: string) => string;
  levels: { id: string; cssClass: string }[];
  stats: { label: string; matchLevels: string[]; cssStatClass: string }[];
  filterOptions: { value: string; label: string; matchLevels?: string[] }[];
}

/** CSS class to use for a given severity level */
const SEVERITY_CSS: Record<string, string> = {
  critical: "flai-log-line--critical",
  error: "flai-log-line--error",
  warning: "flai-log-line--warning",
  info: "flai-log-line--info",
};

interface CompiledPattern {
  id: string;
  regex: RegExp;
  level: string;
  label: string;
}

/**
 * Build a log viewer config from stored patterns + built-in defaults.
 * Each stored pattern gets a unique level ID (pat:<index>) so it can be
 * filtered individually in the dropdown, while inheriting the CSS class
 * from its severity (error/warning/critical).
 */
export function buildConfigFromPatterns(patterns: StoredPattern[]): LogViewerConfig {
  const compiled: CompiledPattern[] = [];

  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i];
    const regex = safeRegex(p.regex);
    if (regex) {
      compiled.push({ id: `pat:${i}`, regex, level: p.level, label: p.label });
    }
  }

  const classifyLine = (text: string): string => {
    // Check stored patterns first — return pattern-specific ID
    for (const cp of compiled) {
      if (safeRegexTest(cp.regex, text)) return cp.id;
    }
    // Built-in defaults
    if (/\bfatal\b|panic|outofmemory|\boom\b/i.test(text)) return "critical";
    if (/\berror\b|\bexception\b|\bfailed\b|\bfailure\b/i.test(text)) return "error";
    if (/\bwarn(?:ing)?\b/i.test(text)) return "warning";
    if (/\binfo\b/i.test(text)) return "info";
    return "normal";
  };

  // Build levels: built-in + one per pattern (CSS class inherited from severity)
  const levels = [
    { id: "critical", cssClass: "flai-log-line--critical" },
    { id: "error", cssClass: "flai-log-line--error" },
    { id: "warning", cssClass: "flai-log-line--warning" },
    { id: "info", cssClass: "flai-log-line--info" },
    { id: "normal", cssClass: "" },
    ...compiled.map((cp) => ({ id: cp.id, cssClass: SEVERITY_CSS[cp.level] || "" })),
  ];

  // Collect all pattern IDs grouped by severity for the grouped filters
  const patternIdsBySeverity: Record<string, string[]> = {};
  for (const cp of compiled) {
    if (!patternIdsBySeverity[cp.level]) patternIdsBySeverity[cp.level] = [];
    patternIdsBySeverity[cp.level].push(cp.id);
  }

  // Stats: include pattern IDs in the matching severity bucket
  const stats = [
    { label: "critical", matchLevels: ["critical", ...(patternIdsBySeverity["critical"] || [])], cssStatClass: "flai-log-viewer__stat--critical" },
    { label: "errors", matchLevels: ["error", ...(patternIdsBySeverity["error"] || [])], cssStatClass: "flai-log-viewer__stat--error" },
    { label: "warnings", matchLevels: ["warning", ...(patternIdsBySeverity["warning"] || [])], cssStatClass: "flai-log-viewer__stat--warning" },
  ];

  // Filter options: grouped severity filters include pattern IDs, then individual pattern entries
  const filterOptions: { value: string; label: string; matchLevels?: string[] }[] = [
    { value: "all", label: "All" },
    { value: "errors", label: "Errors", matchLevels: ["critical", "error", ...(patternIdsBySeverity["critical"] || []), ...(patternIdsBySeverity["error"] || [])] },
    { value: "warnings", label: "Warnings", matchLevels: ["warning", ...(patternIdsBySeverity["warning"] || [])] },
    { value: "info", label: "Info", matchLevels: ["info"] },
    ...compiled.map((cp) => ({ value: cp.id, label: `★ ${cp.label}`, matchLevels: [cp.id] })),
  ];

  return { classifyLine, levels, stats, filterOptions };
}

/** Default config with only built-in regex rules (no stored patterns). */
export function buildDefaultConfig(): LogViewerConfig {
  return buildConfigFromPatterns([]);
}
