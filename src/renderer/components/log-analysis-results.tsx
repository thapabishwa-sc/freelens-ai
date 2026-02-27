import { useState, useEffect, useCallback } from "react";
import { observer } from "mobx-react";
import { logAnalysisStore } from "../stores/log-analysis-store";
import { isClaudeAvailable, loadPersistedAuth } from "../services/claude-client";
import type { LogAnalysis } from "../services/log-analyze";

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#3b82f6",
};

const PATTERN_COLORS: Record<string, string> = {
  error: "#ef4444",
  warning: "#eab308",
  info: "#3b82f6",
};

const HEALTH_COLORS: Record<string, string> = {
  healthy: "#22c55e",
  warning: "#eab308",
  critical: "#ef4444",
  unknown: "#6b7280",
};

// ── Inner results display ──

export function LogResults({ data }: { data: LogAnalysis }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flai-log-analysis">
      <div className="flai-log-analysis__header">
        <div className="flai-log-analysis__title-row">
          <span
            className="flai-badge flai-badge--small"
            style={{ backgroundColor: HEALTH_COLORS[data.health] || HEALTH_COLORS.unknown }}
          >
            {data.health}
          </span>
          <span className="flai-log-analysis__counts">
            {data.errorCount > 0 && (
              <span className="flai-log-analysis__count--error">{data.errorCount} errors</span>
            )}
            {data.errorCount > 0 && data.warningCount > 0 && " · "}
            {data.warningCount > 0 && (
              <span className="flai-log-analysis__count--warning">{data.warningCount} warnings</span>
            )}
          </span>
        </div>
        <button
          type="button"
          className="flai-log-analysis__toggle"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? "Expand" : "Collapse"}
          aria-label={collapsed ? "Expand results" : "Collapse results"}
          aria-expanded={!collapsed}
        >
          {collapsed ? "▸" : "▾"}
        </button>
      </div>

      {!collapsed && (
        <div className="flai-log-analysis__body">
          <p className="flai-log-analysis__summary">{data.summary}</p>

          {/* Patterns */}
          {data.patterns.length > 0 && (
            <div className="flai-log-analysis__section">
              <h4 className="flai-log-analysis__section-title">Patterns</h4>
              {data.patterns.map((p, i) => (
                <div key={i} className="flai-log-analysis__pattern">
                  <span
                    className="flai-log-analysis__pattern-badge"
                    style={{ backgroundColor: PATTERN_COLORS[p.severity] || "#6b7280" }}
                  >
                    {p.severity} ×{p.count}
                  </span>
                  <span className="flai-log-analysis__pattern-text">{p.pattern}</span>
                  <code className="flai-log-analysis__pattern-example">{p.example}</code>
                </div>
              ))}
            </div>
          )}

          {/* Anomalies */}
          {data.anomalies.length > 0 && (
            <div className="flai-log-analysis__section">
              <h4 className="flai-log-analysis__section-title">Anomalies</h4>
              {data.anomalies.map((a, i) => (
                <div key={i} className="flai-log-analysis__anomaly">
                  <span
                    className="flai-issue__dot"
                    style={{ backgroundColor: SEVERITY_COLORS[a.severity] || "#6b7280" }}
                  />
                  <div className="flai-issue__content">
                    <span className="flai-issue__severity">{a.severity}</span>
                    <span className="flai-issue__desc">{a.description}</span>
                    {a.timeRange && (
                      <span className="flai-log-analysis__time-range">{a.timeRange}</span>
                    )}
                    {a.detail && <div className="flai-issue__detail">{a.detail}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Recommendations */}
          {data.recommendations.length > 0 && (
            <div className="flai-log-analysis__section">
              <h4 className="flai-log-analysis__section-title">Recommendations</h4>
              <ol className="flai-results__list">
                {data.recommendations.map((rec, i) => (
                  <li key={i}>{rec}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main panel (mounted by log-injector) ──

interface LogAnalysisPanelProps {
  namespace: string;
  podName: string;
  container?: string;
  error?: string;
}

export const LogAnalysisPanel = observer(function LogAnalysisPanel({
  namespace,
  podName,
  container,
  error: externalError,
}: LogAnalysisPanelProps) {
  // Check auth on mount
  useEffect(() => {
    loadPersistedAuth();
  }, []);

  const state = logAnalysisStore.getState(namespace, podName, container);
  const isAuthed = isClaudeAvailable();

  const handleAnalyze = useCallback((force?: boolean) => {
    logAnalysisStore.analyze(namespace, podName, container, force);
  }, [namespace, podName, container]);

  // Auto-trigger on first mount if authenticated
  useEffect(() => {
    if (isAuthed && state.status === "idle" && namespace && podName) {
      handleAnalyze();
    }
  }, [isAuthed, namespace, podName]);

  if (externalError) {
    return <div className="flai-error" role="alert">{externalError}</div>;
  }

  return (
    <div className="flai-log-panel__body">
      {state.status === "idle" && (
        <div className="flai-log-dock__placeholder">
          Click to start analysis
        </div>
      )}

      {state.status === "loading" && (
        <div className="flai-loading" aria-live="polite">
          <span className="flai-spinner"><span /><span /><span /></span>
          <span>Analyzing logs...</span>
        </div>
      )}

      {state.status === "error" && (
        <>
          <div className="flai-error" role="alert">{(state as any).error}</div>
          <button
            type="button"
            className="flai-btn flai-btn--primary flai-btn--small"
            onClick={() => handleAnalyze(true)}
            style={{ marginTop: 6 }}
          >
            Retry
          </button>
        </>
      )}

      {state.status === "success" && (
        <>
          <div className="flai-log-panel__actions">
            <button
              type="button"
              className="flai-btn flai-btn--link flai-btn--small"
              onClick={() => handleAnalyze(true)}
            >
              Re-analyze
            </button>
          </div>
          <LogResults data={(state as any).data} />
        </>
      )}
    </div>
  );
});
