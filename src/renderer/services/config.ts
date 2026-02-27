import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface FreeLensAIConfig {
  logTailLines: number;
  analysisMaxTokens: number;
  apiTimeoutMs: number;
  resourceCacheTtlMs: number;
  logCacheTtlMs: number;
  maxRelationshipChildren: number;
}

const DEFAULTS: FreeLensAIConfig = {
  logTailLines: 500,
  analysisMaxTokens: 4096,
  apiTimeoutMs: 45_000,
  resourceCacheTtlMs: 5 * 60 * 1000,  // 5 minutes
  logCacheTtlMs: 3 * 60 * 1000,       // 3 minutes
  maxRelationshipChildren: 50,
};

const CONFIG_FILE = join(homedir(), ".freelens-ai", "config.json");

/** Clamp a value to [min, max], falling back to default if not a finite number. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function validateConfig(raw: Record<string, unknown>): FreeLensAIConfig {
  const merged = { ...DEFAULTS, ...raw };
  return {
    logTailLines: clampInt(merged.logTailLines, 10, 10_000, DEFAULTS.logTailLines),
    analysisMaxTokens: clampInt(merged.analysisMaxTokens, 256, 16_384, DEFAULTS.analysisMaxTokens),
    apiTimeoutMs: clampInt(merged.apiTimeoutMs, 5_000, 120_000, DEFAULTS.apiTimeoutMs),
    resourceCacheTtlMs: clampInt(merged.resourceCacheTtlMs, 0, 30 * 60_000, DEFAULTS.resourceCacheTtlMs),
    logCacheTtlMs: clampInt(merged.logCacheTtlMs, 0, 30 * 60_000, DEFAULTS.logCacheTtlMs),
    maxRelationshipChildren: clampInt(merged.maxRelationshipChildren, 10, 500, DEFAULTS.maxRelationshipChildren),
  };
}

let _config: FreeLensAIConfig | null = null;

export function getConfig(): FreeLensAIConfig {
  if (!_config) {
    try {
      const raw = readFileSync(CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      _config = validateConfig(parsed);
    } catch {
      _config = { ...DEFAULTS };
    }
  }
  return _config!;
}

/** Force reload config from disk on next access */
export function reloadConfig(): void {
  _config = null;
}
