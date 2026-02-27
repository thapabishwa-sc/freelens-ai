import { useState, useRef, useCallback, useEffect } from "react";
import { observer } from "mobx-react";
import { logPanelStore } from "../stores/log-panel-store";
import { logAnalysisStore } from "../stores/log-analysis-store";
import { patternManagerStore } from "../stores/pattern-manager-store";
import { isClaudeAvailable, loadPersistedAuth } from "../services/claude-client";
import { LogViewer } from "./log-viewer";
import { LogInsightsSidebar } from "./log-insights-sidebar";
import { ErrorBoundary } from "./error-boundary";

const MIN_HEIGHT = 200;
const DEFAULT_HEIGHT = 400;
const MAX_HEIGHT_RATIO = 0.7;
const MIN_SIDEBAR_WIDTH = 200;
const DEFAULT_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 600;

export const LogBottomPanel = observer(function LogBottomPanel() {
  const { isOpen, minimized, tabs, activeTabId, activeTab, sidebarVisible } = logPanelStore;
  const [panelHeight, setPanelHeight] = useState(DEFAULT_HEIGHT);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [bottomOffset, setBottomOffset] = useState(0);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    loadPersistedAuth();
    patternManagerStore.loadStoredPatterns();

    // Detect FreeLens status bar to position panel above it
    const statusBar = document.querySelector(".StatusBar");
    if (statusBar) {
      setBottomOffset(statusBar.getBoundingClientRect().height);
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setBottomOffset(entry.contentRect.height);
        }
      });
      ro.observe(statusBar);
      return () => ro.disconnect();
    }
    return undefined;
  }, []);

  // Auto-show sidebar when analysis succeeds for the active tab
  useEffect(() => {
    if (!activeTab) return;
    const state = logAnalysisStore.getState(activeTab.namespace, activeTab.podName, activeTab.container);
    if (state.status === "success" && !sidebarVisible) {
      logPanelStore.sidebarVisible = true;
    }
  }, [activeTab?.id, activeTab && logAnalysisStore.getState(activeTab.namespace, activeTab.podName, activeTab.container).status]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: panelHeight };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - ev.clientY;
      const maxH = window.innerHeight * MAX_HEIGHT_RATIO;
      const newH = Math.min(maxH, Math.max(MIN_HEIGHT, dragRef.current.startH + delta));
      setPanelHeight(newH);
    };

    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [panelHeight]);

  const handleSidebarDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarDragRef.current = { startX: e.clientX, startW: sidebarWidth };

    const onMove = (ev: MouseEvent) => {
      if (!sidebarDragRef.current) return;
      const delta = sidebarDragRef.current.startX - ev.clientX;
      const newW = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, sidebarDragRef.current.startW + delta));
      setSidebarWidth(newW);
    };

    const onUp = () => {
      sidebarDragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  if (!isOpen || tabs.length === 0) return null;

  const isAuthed = isClaudeAvailable();

  // Minimized: show just the tab bar pinned to the bottom
  if (minimized) {
    return (
      <div className="flai-log-dock flai-log-dock--minimized" style={{ bottom: bottomOffset }}>
        <div className="flai-log-dock__tabbar">
          <div className="flai-log-dock__tabbar-tabs">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                role="tab"
                tabIndex={0}
                aria-selected={tab.id === activeTabId}
                className={`flai-log-dock__tab ${tab.id === activeTabId ? "flai-log-dock__tab--active" : ""}`}
                onClick={() => {
                  logPanelStore.activeTabId = tab.id;
                  logPanelStore.restore();
                }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { logPanelStore.activeTabId = tab.id; logPanelStore.restore(); } }}
                title={`${tab.namespace}/${tab.podName}/${tab.container}`}
              >
                <span className="flai-log-dock__tab-label">
                  {tab.podName}<span className="flai-log-dock__tab-sep">/</span>{tab.container}
                </span>
                <button
                  type="button"
                  className="flai-log-dock__tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    logPanelStore.closeTab(tab.id);
                  }}
                  title="Close tab"
                  aria-label={`Close ${tab.podName} tab`}
                >
                  {"\u2715"}
                </button>
              </div>
            ))}
          </div>

          <div className="flai-log-dock__tabbar-controls">
            <button
              type="button"
              className="flai-log-dock__restore"
              onClick={() => logPanelStore.restore()}
              title="Restore panel"
              aria-label="Restore log panel"
            >
              {"\u25B2"}
            </button>
            <button
              type="button"
              className="flai-log-dock__close"
              onClick={() => logPanelStore.close()}
              title="Close all"
              aria-label="Close all log tabs"
            >
              {"\u2715"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flai-log-dock" style={{ height: panelHeight, bottom: bottomOffset }}>
      {/* Drag handle */}
      <div className="flai-log-dock__resize" onMouseDown={handleDragStart}>
        <div className="flai-log-dock__resize-dots" />
      </div>

      {/* Tab bar */}
      <div className="flai-log-dock__tabbar">
        <div className="flai-log-dock__tabbar-tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              tabIndex={0}
              aria-selected={tab.id === activeTabId}
              className={`flai-log-dock__tab ${tab.id === activeTabId ? "flai-log-dock__tab--active" : ""}`}
              onClick={() => { logPanelStore.activeTabId = tab.id; }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { logPanelStore.activeTabId = tab.id; } }}
              title={`${tab.namespace}/${tab.podName}/${tab.container}`}
            >
              <span className="flai-log-dock__tab-label">
                {tab.podName}<span className="flai-log-dock__tab-sep">/</span>{tab.container}
              </span>
              <button
                type="button"
                className="flai-log-dock__tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  logPanelStore.closeTab(tab.id);
                }}
                title="Close tab"
                aria-label={`Close ${tab.podName} tab`}
              >
                {"\u2715"}
              </button>
            </div>
          ))}
        </div>

        <span className="flai-log-dock__tabbar-divider" />

        <div className="flai-log-dock__tabbar-controls">
          {isAuthed && (
            <select
              className="flai-select"
              value={logAnalysisStore.model}
              onChange={(e) => { logAnalysisStore.model = e.target.value as "haiku" | "sonnet"; }}
              title="AI model for analysis"
            >
              <option value="haiku">Haiku (fast)</option>
              <option value="sonnet">Sonnet (detailed)</option>
            </select>
          )}
          <button
            type="button"
            className={`flai-log-dock__sidebar-toggle ${sidebarVisible ? "flai-log-dock__sidebar-toggle--active" : ""}`}
            onClick={() => logPanelStore.toggleSidebar()}
            title={sidebarVisible ? "Hide AI insights" : "Show AI insights"}
            aria-label="Toggle AI insights sidebar"
            aria-expanded={sidebarVisible}
          >
            {"\u25E7"} AI
          </button>
          <button
            type="button"
            className="flai-log-dock__minimize"
            onClick={() => logPanelStore.hide()}
            title="Minimize panel"
            aria-label="Minimize log panel"
          >
            {"\u2014"}
          </button>
          <button
            type="button"
            className="flai-log-dock__close"
            onClick={() => logPanelStore.close()}
            title="Close all"
            aria-label="Close all log tabs"
          >
            {"\u2715"}
          </button>
        </div>
      </div>

      {/* Content: LogViewer + optional AI Insights sidebar */}
      <div className="flai-log-dock__body">
        {activeTab ? (
          <div className="flai-log-dock__split">
            <div className="flai-log-dock__viewer-pane">
              <ErrorBoundary label="Log Viewer">
                <LogViewer
                  key={`viewer-${activeTab.id}`}
                  tab={activeTab}
                  workloadScope={activeTab.workloadScope}
                  appIdentity={activeTab.appIdentity}
                />
              </ErrorBoundary>
            </div>
            {sidebarVisible && (
              <>
              <div className="flai-log-dock__sidebar-drag" onMouseDown={handleSidebarDragStart} />
              <div className="flai-log-dock__insights-pane" style={{ width: sidebarWidth }}>
                <ErrorBoundary label="AI Insights">
                  <LogInsightsSidebar
                    key={`insights-${activeTab.id}`}
                    namespace={activeTab.namespace}
                    podName={activeTab.podName}
                    container={activeTab.container}
                    workloadScope={activeTab.workloadScope}
                    appIdentity={activeTab.appIdentity}
                  />
                </ErrorBoundary>
              </div>
              </>
            )}
          </div>
        ) : (
          <div className="flai-log-dock__placeholder">
            Select a tab to view logs
          </div>
        )}
      </div>
    </div>
  );
});
