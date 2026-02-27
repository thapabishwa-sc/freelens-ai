import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { logger } from "./logger";

// ── Types ──

export interface StoredPattern {
  id: string;
  label: string;
  regex: string;
  level: "error" | "warning" | "info" | "critical";
  discoveredAt: number;
  hitCount: number;
  description: string;
  example: string;
}

export interface PatternStore {
  version: 1;
  updatedAt: number;
  scopes: Record<string, StoredPattern[]>;
}

export interface PatternRegex {
  regex: string;
  level: "error" | "warning" | "info" | "critical";
  label: string;
  description: string;
}

// ── Constants ──

const CONFIG_DIR = join(homedir(), ".freelens-ai");
const PATTERNS_FILE = join(CONFIG_DIR, "patterns.json");
const MAX_PATTERNS_PER_SCOPE = 50;

function defaultStore(): PatternStore {
  return { version: 1, updatedAt: 0, scopes: {} };
}

function generateId(): string {
  return randomBytes(8).toString("hex");
}

// ── File I/O ──

export function loadPatterns(): PatternStore {
  try {
    const data = readFileSync(PATTERNS_FILE, "utf-8");
    const parsed = JSON.parse(data);
    if (parsed && parsed.version === 1 && parsed.scopes) {
      return parsed as PatternStore;
    }
    return defaultStore();
  } catch {
    return defaultStore();
  }
}

// Write queue to serialize concurrent saves
let writeQueue: Promise<void> = Promise.resolve();

export function savePatterns(store: PatternStore): void {
  writeQueue = writeQueue.then(() => {
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      store.updatedAt = Date.now();
      writeFileSync(PATTERNS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
    } catch (err) {
      logger.warn("Failed to write patterns file:", err);
    }
  }).catch(() => {});
}

// ── Workload scope helpers ──

/** Workload type abbreviations */
const WORKLOAD_ABBREV: Record<string, string> = {
  Deployment: "deploy",
  StatefulSet: "sts",
  DaemonSet: "ds",
  ReplicaSet: "rs",
  Job: "job",
  CronJob: "cronjob",
};

/**
 * Extract a cross-namespace app identity from standard pod labels.
 * Priority: chart labels → app.kubernetes.io/name → app label.
 * The chart label groups all pods from the same Helm release chart,
 * so patterns learned from one instance apply everywhere.
 */
export function extractAppIdentity(pod: any): string | undefined {
  const labels: Record<string, string> = pod?.metadata?.labels || {};

  // Chart labels (highest priority — same chart = same log patterns)
  const helmChart = labels["helm.sh/chart"];
  if (helmChart) return `chart:${helmChart}`;
  const chart = labels["chart"];
  if (chart) return `chart:${chart}`;

  // Standard Kubernetes recommended labels
  const k8sName = labels["app.kubernetes.io/name"];
  if (k8sName) return `app:${k8sName}`;

  // Common convention
  const appLabel = labels["app"];
  if (appLabel) return `app:${appLabel}`;

  return undefined;
}

/**
 * Extract workload scope from a pod's ownerReferences.
 * Resolves ReplicaSet owners to their parent Deployment by stripping the hash suffix.
 * Returns a string like "deploy:my-app" or undefined for standalone pods.
 */
export function extractWorkloadScope(pod: any): string | undefined {
  const owners: any[] = pod?.metadata?.ownerReferences || [];
  if (owners.length === 0) return undefined;

  // Pick the controller owner (or first)
  const owner = owners.find((o: any) => o.controller) || owners[0];
  if (!owner?.kind || !owner?.name) return undefined;

  // ReplicaSet → resolve to Deployment by stripping the hash suffix
  // Kubernetes naming: {deployment-name}-{pod-template-hash}
  if (owner.kind === "ReplicaSet") {
    const lastDash = owner.name.lastIndexOf("-");
    if (lastDash > 0) {
      const deployName = owner.name.slice(0, lastDash);
      return `deploy:${deployName}`;
    }
    return `rs:${owner.name}`;
  }

  const abbrev = WORKLOAD_ABBREV[owner.kind];
  if (abbrev) return `${abbrev}:${owner.name}`;

  // Unknown owner kind — use kind directly
  return `${owner.kind.toLowerCase()}:${owner.name}`;
}

/**
 * Resolve the primary scope key for a pod.
 * Priority: app label (e.g. "app:nginx") → workload owner (e.g. "deploy:my-app") → namespace fallback.
 */
export function resolveScopeKey(namespace: string, workloadScope?: string, appIdentity?: string): string {
  return appIdentity || workloadScope || `ns:${namespace}`;
}

/**
 * Get patterns for a pod, merging app-level patterns with global ones.
 * Uses label-based app identity as the primary key so patterns are shared
 * across all namespaces running the same app.
 */
export function getPatternsForScope(
  store: PatternStore,
  namespace: string,
  workloadScope?: string,
  appIdentity?: string,
): StoredPattern[] {
  const key = resolveScopeKey(namespace, workloadScope, appIdentity);
  const appPatterns = store.scopes[key] || [];
  const globalPatterns = store.scopes["global"] || [];

  // Merge: app-specific > global (dedup by regex)
  const seen = new Set<string>();
  const result: StoredPattern[] = [];

  for (const p of appPatterns) { seen.add(p.regex); result.push(p); }
  for (const p of globalPatterns) { if (!seen.has(p.regex)) result.push(p); }

  return result;
}

// ── Merge AI-discovered patterns ──

export function mergeAIPatterns(
  store: PatternStore,
  scope: string,
  newPatterns: PatternRegex[],
  examples?: Map<string, string>,
  logLines?: string[],
): void {
  if (!store.scopes[scope]) {
    store.scopes[scope] = [];
  }

  const existing = store.scopes[scope];

  for (const np of newPatterns) {
    // Validate regex
    let newRegex: RegExp;
    try {
      newRegex = new RegExp(np.regex, "i");
    } catch {
      continue; // Skip invalid regex
    }

    // Check for exact regex match
    const exactMatch = existing.find((e) => e.regex === np.regex);
    if (exactMatch) {
      exactMatch.hitCount += 1;
      exactMatch.label = np.label;
      exactMatch.description = np.description;
      continue;
    }

    // Check for overlapping patterns: if >80% of lines matched by the new
    // regex are also matched by an existing pattern, treat it as a duplicate
    if (logLines && logLines.length > 0) {
      const newMatches = logLines.filter((l) => newRegex.test(l));
      if (newMatches.length > 0) {
        let isDuplicate = false;
        for (const ep of existing) {
          try {
            const existingRegex = new RegExp(ep.regex, "i");
            const overlap = newMatches.filter((l) => existingRegex.test(l)).length;
            if (overlap / newMatches.length >= 0.8) {
              // Overlapping pattern — treat as duplicate, bump hit count
              ep.hitCount += 1;
              isDuplicate = true;
              break;
            }
          } catch { /* skip invalid existing regex */ }
        }
        if (isDuplicate) continue;
      }
    }

    existing.push({
      id: generateId(),
      label: np.label,
      regex: np.regex,
      level: np.level,
      discoveredAt: Date.now(),
      hitCount: 1,
      description: np.description,
      example: examples?.get(np.regex) || "",
    });
  }

  // Cap per scope
  if (existing.length > MAX_PATTERNS_PER_SCOPE) {
    existing.sort((a, b) => b.hitCount - a.hitCount || b.discoveredAt - a.discoveredAt);
    store.scopes[scope] = existing.slice(0, MAX_PATTERNS_PER_SCOPE);
  }

  savePatterns(store);
}

// ── Remove pattern ──

export function removePattern(store: PatternStore, scope: string, patternId: string): void {
  const patterns = store.scopes[scope];
  if (!patterns) return;
  store.scopes[scope] = patterns.filter((p) => p.id !== patternId);
  savePatterns(store);
}
