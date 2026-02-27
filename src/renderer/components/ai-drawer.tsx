import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { observer } from "mobx-react";
import { aiDrawerStore } from "../stores/ai-drawer-store";
import { AuthPanel } from "./auth-panel";
import { AnalysisResults, AIErrorBoundary, formatAge } from "./analysis-results";
import { LogInsightsSidebar } from "./log-insights-sidebar";

const AIDrawerContent = observer(() => {
  const { isOpen, targetObject, targetKind, analysisState, isAuthenticated, mode } = aiDrawerStore;
  const [animating, setAnimating] = useState(false);

  // Animate open/close
  useEffect(() => {
    if (isOpen) {
      setAnimating(true);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && aiDrawerStore.isOpen) {
        aiDrawerStore.close();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleBackdropClick = useCallback(() => {
    aiDrawerStore.close();
  }, []);

  const handleAnalyze = useCallback((force?: boolean) => {
    aiDrawerStore.analyze(force);
  }, []);

  const handleLogout = useCallback(() => {
    aiDrawerStore.handleLogout();
  }, []);

  const handleAuthenticated = useCallback(() => {
    aiDrawerStore.setAuthenticated(true);
  }, []);

  // Handle transition end to fully unmount after close animation
  const handleTransitionEnd = useCallback(() => {
    if (!isOpen) {
      setAnimating(false);
    }
  }, [isOpen]);

  // Don't render if closed and not animating
  if (!isOpen && !animating) return null;

  const meta = (targetObject as any)?.metadata || {};
  const name = meta.name || "unknown";
  const namespace = meta.namespace;
  const isLoading = analysisState.status === "loading";
  const hasResult = analysisState.status === "success";
  const hasError = analysisState.status === "error";
  const buttonLabel = isLoading ? "Analyzing..." : hasResult ? "Re-analyze" : hasError ? "Retry" : "Analyze with Claude";
  const buttonStyle = hasResult ? "flai-btn--secondary" : "flai-btn--primary";

  const isLogMode = mode === "log";
  const drawerTitle = isLogMode ? "AI Log Analysis" : "AI Analysis";

  return (
    <div className={`flai-drawer ${isOpen ? "flai-drawer--open" : ""}`} onTransitionEnd={handleTransitionEnd}>
      <div className="flai-drawer__backdrop" onClick={handleBackdropClick} role="button" aria-label="Close drawer" tabIndex={-1} />
      <div className="flai-drawer__panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flai-drawer__header">
          <h2 className="flai-drawer__title">{drawerTitle}</h2>
          <div className="flai-drawer__controls">
            <button
              type="button"
              className="flai-drawer__close"
              onClick={() => aiDrawerStore.close()}
              title="Close"
              aria-label="Close AI drawer"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flai-drawer__body">
          {/* Resource info */}
          {targetObject && (
            <div className="flai-drawer__resource-info">
              <span className="flai-drawer__resource-kind">{targetKind}</span>
              <span className="flai-drawer__resource-name">
                {namespace ? `${namespace}/` : ""}{name}
                {isLogMode && aiDrawerStore.logContainer && (
                  <span style={{ opacity: 0.6 }}> / {aiDrawerStore.logContainer}</span>
                )}
              </span>
            </div>
          )}

          {!isAuthenticated ? (
            <AuthPanel onAuthenticated={handleAuthenticated} />
          ) : isLogMode ? (
            <LogInsightsSidebar
              key={`${aiDrawerStore.logNamespace}/${aiDrawerStore.logPodName}/${aiDrawerStore.logContainer}`}
              namespace={aiDrawerStore.logNamespace}
              podName={aiDrawerStore.logPodName}
              container={aiDrawerStore.logContainer}
            />
          ) : (
            <>
              {/* Analyze button */}
              <div className="flai-panel__actions">
                <button
                  type="button"
                  className={`flai-btn ${buttonStyle}`}
                  onClick={() => handleAnalyze(hasResult || hasError)}
                  disabled={isLoading}
                >
                  {isLoading && <span className="flai-spinner flai-spinner--inline"><span /><span /><span /></span>}
                  {buttonLabel}
                </button>
              </div>

              {/* Error */}
              {hasError && (
                <div className="flai-error" role="alert">{(analysisState as any).error}</div>
              )}

              {/* Results */}
              {hasResult && (
                <AnalysisResults
                  data={(analysisState as any).data}
                  cachedAt={(analysisState as any).cachedAt}
                  currentKind={targetKind}
                  currentName={name}
                  currentNamespace={namespace}
                />
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {isAuthenticated && !isLogMode && (
          <div className="flai-drawer__footer">
            {hasResult ? (
              <span className="flai-drawer__cache-info">
                Cached {formatAge((analysisState as any).cachedAt)}
              </span>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="flai-btn flai-btn--link flai-btn--small"
              onClick={handleLogout}
            >
              Logout
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

export function AIDrawer() {
  return createPortal(
    <AIErrorBoundary>
      <AIDrawerContent />
    </AIErrorBoundary>,
    document.body
  );
}
