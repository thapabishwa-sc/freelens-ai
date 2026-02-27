import { makeAutoObservable } from "mobx";
import {
  loadPatterns,
  mergeAIPatterns,
  getPatternsForScope,
  removePattern as removePatternFromStore,
  resolveScopeKey,
  type PatternStore,
  type StoredPattern,
} from "../services/pattern-storage";
import { getCachedLogLines, type LogAnalysis } from "../services/log-analyze";

/**
 * Lightweight MobX store for pattern management.
 * Handles loading/saving/merging learned patterns from AI analysis.
 */
class PatternManagerStore {
  patternStore: PatternStore = { version: 1, updatedAt: 0, scopes: {} };

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
    this.loadStoredPatterns();
  }

  loadStoredPatterns(): void {
    this.patternStore = loadPatterns();
  }

  getStoredPatterns(namespace: string, workloadScope?: string, appIdentity?: string): StoredPattern[] {
    return getPatternsForScope(this.patternStore, namespace, workloadScope, appIdentity);
  }

  updatePatternsFromAnalysis(namespace: string, analysis: LogAnalysis, workloadScope?: string, appIdentity?: string, podName?: string, container?: string): void {
    if (!analysis.patternRegexes || analysis.patternRegexes.length === 0) return;

    const scope = resolveScopeKey(namespace, workloadScope, appIdentity);

    // Build example map from analysis patterns
    const examples = new Map<string, string>();
    for (const pr of analysis.patternRegexes) {
      const match = analysis.patterns.find(
        (p) => p.pattern.toLowerCase().includes(pr.label.toLowerCase()) ||
          pr.label.toLowerCase().includes(p.pattern.toLowerCase()),
      );
      if (match) {
        examples.set(pr.regex, match.example);
      }
    }

    // Get cached log lines for overlap-based dedup
    const logLines = podName ? getCachedLogLines(namespace, podName, container) : [];

    mergeAIPatterns(this.patternStore, scope, analysis.patternRegexes, examples, logLines);
  }

  removePattern(namespace: string, patternId: string, workloadScope?: string, appIdentity?: string): void {
    const scope = resolveScopeKey(namespace, workloadScope, appIdentity);
    removePatternFromStore(this.patternStore, scope, patternId);
  }
}

export const patternManagerStore = new PatternManagerStore();
