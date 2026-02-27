import { useState, useEffect, useCallback } from "react";
import { observer } from "mobx-react";
import { logAnalysisStore } from "../stores/log-analysis-store";
import { patternManagerStore } from "../stores/pattern-manager-store";
import { isClaudeAvailable, loadPersistedAuth } from "../services/claude-client";
import { LogResults } from "./log-analysis-results";
import type { StoredPattern } from "../services/pattern-storage";
import { formatAge } from "../utils/format";

const LEVEL_COLORS: Record<string, string> = {
  critical: "#ef4444",
  error: "#ef4444",
  warning: "#eab308",
  info: "#3b82f6",
};

interface LogInsightsSidebarProps {
  namespace: string;
  podName: string;
  container?: string;
  workloadScope?: string;
  appIdentity?: string;
}

export const LogInsightsSidebar = observer(function LogInsightsSidebar({
  namespace,
  podName,
  container,
  workloadScope,
  appIdentity,
}: LogInsightsSidebarProps) {
  const [copiedSummary, setCopiedSummary] = useState(false);

  useEffect(() => {
    loadPersistedAuth();
  }, []);

  const state = logAnalysisStore.getState(namespace, podName, container);
  const isAuthed = isClaudeAvailable();
  const storedPatterns = patternManagerStore.getStoredPatterns(namespace, workloadScope, appIdentity);

  const handleAnalyze = useCallback(
    (force?: boolean) => {
      logAnalysisStore.analyze(namespace, podName, container, force);
    },
    [namespace, podName, container],
  );

  // Auto-trigger analysis on mount if authenticated and idle
  useEffect(() => {
    if (isAuthed && state.status === "idle" && namespace && podName) {
      handleAnalyze();
    }
  }, [isAuthed, namespace, podName]);

  // When analysis succeeds, persist patterns at workload scope
  useEffect(() => {
    if (state.status === "success") {
      const data = (state as any).data;
      if (data?.patternRegexes?.length > 0) {
        patternManagerStore.updatePatternsFromAnalysis(namespace, data, workloadScope, appIdentity, podName, container);
      }
    }
  }, [state.status, namespace, workloadScope]);

  const handleDeletePattern = useCallback(
    (patternId: string) => {
      patternManagerStore.removePattern(namespace, patternId, workloadScope, appIdentity);
    },
    [namespace, workloadScope, appIdentity],
  );

  const handleCopySummary = useCallback(() => {
    if (state.status !== "success") return;
    const data = (state as any).data;
    const text = [
      `Health: ${data.health}`,
      `Summary: ${data.summary}`,
      data.patterns.length > 0 ? `\nPatterns:\n${data.patterns.map((p: any) => `- [${p.severity}] ${p.pattern} (x${p.count})`).join("\n")}` : "",
      data.anomalies.length > 0 ? `\nAnomalies:\n${data.anomalies.map((a: any) => `- [${a.severity}] ${a.description}`).join("\n")}` : "",
      data.recommendations.length > 0 ? `\nRecommendations:\n${data.recommendations.map((r: string, i: number) => `${i + 1}. ${r}`).join("\n")}` : "",
    ].filter(Boolean).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopiedSummary(true);
      setTimeout(() => setCopiedSummary(false), 2000);
    }).catch(() => {});
  }, [state]);

  const cachedAt = state.status === "success" ? (state as any).cachedAt : null;

  return (
    <div className="flai-log-insights">
      {/* Header */}
      <div className="flai-log-insights__header">
        <h3 className="flai-log-insights__title">AI Insights</h3>
        <div className="flai-log-insights__header-actions">
          {state.status === "success" && (
            <button
              type="button"
              className={`flai-log-insights__copy-btn ${copiedSummary ? "flai-log-insights__copy-btn--copied" : ""}`}
              onClick={handleCopySummary}
              title="Copy analysis to clipboard"
            >
              {copiedSummary ? "\u2713 Copied" : "Copy"}
            </button>
          )}
          {isAuthed && (
            <button
              type="button"
              className="flai-btn flai-btn--primary flai-btn--small"
              onClick={() => handleAnalyze(state.status === "success")}
              disabled={state.status === "loading"}
            >
              {state.status === "loading" ? "Analyzing..." : state.status === "success" ? "\u21BB Re-analyze" : "Analyze"}
            </button>
          )}
        </div>
      </div>

      {/* Timestamp */}
      {cachedAt && (
        <div className="flai-log-insights__timestamp">
          Analyzed {formatAge(cachedAt)}
        </div>
      )}

      {/* Auth warning */}
      {!isAuthed && (
        <div className="flai-log-insights__auth-card">
          <div className="flai-log-insights__auth-text">
            AI analysis requires authentication. Set up your API key to enable log insights.
          </div>
        </div>
      )}

      {/* Loading */}
      {state.status === "loading" && (
        <div className="flai-log-insights__empty-state" aria-live="polite">
          <span className="flai-spinner"><span /><span /><span /></span>
          <div className="flai-log-insights__empty-text">Analyzing logs...</div>
        </div>
      )}

      {/* Error */}
      {state.status === "error" && (
        <div className="flai-log-insights__section">
          <div className="flai-error" role="alert">{(state as any).error}</div>
          <button
            type="button"
            className="flai-btn flai-btn--secondary flai-btn--small"
            onClick={() => handleAnalyze(true)}
            style={{ marginTop: 6 }}
          >
            {"\u21BB"} Retry
          </button>
        </div>
      )}

      {/* Analysis results */}
      {state.status === "success" && (
        <LogResults data={(state as any).data} />
      )}

      {/* Learned patterns — always shown */}
      <div className="flai-log-insights__section">
        <h4 className="flai-log-insights__section-title">
          <span>Learned Patterns</span>
          {storedPatterns.length > 0 && (
            <span className="flai-badge flai-badge--small" style={{ background: "var(--colorVague, rgba(0, 0, 0, 0.08))" }}>
              {storedPatterns.length}
            </span>
          )}
        </h4>

        {storedPatterns.length === 0 ? (
          <div className="flai-log-insights__empty-state">
            <div className="flai-log-insights__empty-text">
              No patterns learned yet. Run an analysis to discover log patterns for this workload.
            </div>
          </div>
        ) : (
          <div className="flai-log-insights__pattern-list">
            {storedPatterns.map((p: StoredPattern) => (
              <div key={p.id} className="flai-log-insights__pattern-item">
                <div className="flai-log-insights__pattern-header">
                  <span
                    className="flai-log-insights__pattern-level"
                    style={{ backgroundColor: LEVEL_COLORS[p.level] || "#6b7280" }}
                  >
                    {p.level}
                  </span>
                  <button
                    type="button"
                    className="flai-log-insights__pattern-delete"
                    onClick={() => handleDeletePattern(p.id)}
                    title="Remove pattern"
                    aria-label={`Remove pattern ${p.label}`}
                  >
                    {"\u2715"}
                  </button>
                </div>
                <span className="flai-log-insights__pattern-label">{p.label}</span>
                {p.description && (
                  <span className="flai-log-insights__pattern-description">{p.description}</span>
                )}
                <span className="flai-log-insights__pattern-regex" title={p.regex}>
                  /{p.regex}/
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
