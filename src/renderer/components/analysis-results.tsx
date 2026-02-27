import React from "react";
import type { ResourceAnalysis } from "../services/analyze";
import { RelationshipGraph } from "./relationship-graph";
import { ErrorBoundary } from "./error-boundary";
export { formatAge } from "../utils/format";

export const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#3b82f6",
};

export const HEALTH_COLORS: Record<string, string> = {
  healthy: "#22c55e",
  warning: "#eab308",
  critical: "#ef4444",
  unknown: "#6b7280",
};

/** Re-export for backward compatibility */
export const AIErrorBoundary = ({ children }: { children: React.ReactNode }) => (
  <ErrorBoundary label="AI Analysis">{children}</ErrorBoundary>
);

// ── Results display ──

interface AnalysisResultsProps {
  data: ResourceAnalysis;
  cachedAt: number;
  currentKind?: string;
  currentName?: string;
  currentNamespace?: string;
}

export function AnalysisResults({ data, currentKind, currentName, currentNamespace }: AnalysisResultsProps) {
  return (
    <div className="flai-results">
      {/* Health badge + summary */}
      <div className="flai-results__health">
        <span
          className="flai-badge"
          style={{ backgroundColor: HEALTH_COLORS[data.health] || HEALTH_COLORS.unknown }}
        >
          {data.health}
        </span>
      </div>
      <p className="flai-results__summary">{data.summary}</p>

      {/* Issues */}
      {data.issues.length > 0 && (
        <div className="flai-results__section">
          <h3 className="flai-results__heading">Issues</h3>
          {data.issues.map((issue, i) => (
            <div key={i} className="flai-issue">
              <span
                className="flai-issue__dot"
                style={{ backgroundColor: SEVERITY_COLORS[issue.severity] || "#6b7280" }}
              />
              <div className="flai-issue__content">
                <span className="flai-issue__severity">{issue.severity}</span>
                <span className="flai-issue__desc">{issue.description}</span>
                {issue.detail && <div className="flai-issue__detail">{issue.detail}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Recommendations */}
      {data.recommendations.length > 0 && (
        <div className="flai-results__section">
          <h3 className="flai-results__heading">Recommendations</h3>
          <ol className="flai-results__list">
            {data.recommendations.map((rec, i) => (
              <li key={i}>{rec}</li>
            ))}
          </ol>
        </div>
      )}

      {/* Relationship graph */}
      {data.relationships && currentKind && currentName && (
        <RelationshipGraph
          relationships={data.relationships}
          currentKind={currentKind}
          currentName={currentName}
          currentNamespace={currentNamespace}
        />
      )}
    </div>
  );
}

