import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import DOMPurify from "dompurify";

// Plain icons to avoid DI dependency — LogViewer is rendered in a portal
// outside FreeLens's React tree, so Renderer.Component.Icon is unavailable.
function ArrowUp() {
  return <span style={{ fontSize: 18, lineHeight: 1 }}>{"\u25B2"}</span>;
}
function ArrowDown() {
  return <span style={{ fontSize: 18, lineHeight: 1 }}>{"\u25BC"}</span>;
}
function DownloadArrow() {
  return <span style={{ fontSize: 14, lineHeight: 1 }}>{"\u2193"}</span>;
}
function SimpleSpinner() {
  return (
    <span className="flai-simple-spinner" />
  );
}
import { FixedSizeList } from "react-window";
import AnsiUpLib from "ansi_up";
import { streamPodLogs, getPodLogs, parseTimestampFromLine, type StreamHandle } from "../services/log-stream";
import { buildConfigFromPatterns, type LogViewerConfig } from "../services/log-classifier";
import { patternManagerStore } from "../stores/pattern-manager-store";
import { logPanelStore, type LogTab } from "../stores/log-panel-store";
import { extractContainers, type ContainerInfo } from "../utils/pod-utils";
import type { StoredPattern } from "../services/pattern-storage";

const AnsiUp = (AnsiUpLib as any).default ?? AnsiUpLib;
const ansiUp = new AnsiUp();
ansiUp.use_classes = false;

const MAX_LINES = 50_000;
const ROW_HEIGHT = 18;
const LOAD_MORE_INCREMENT = 500;

interface LogViewerProps {
  tab: LogTab;
  workloadScope?: string;
  appIdentity?: string;
}

interface ParsedLine {
  lineNumber: number;
  rawTimestamp: string | undefined;
  text: string;
  level: string;
  displayText: string;
}

function trimToMax(text: string): string {
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) {
    return lines.slice(lines.length - MAX_LINES).join("\n");
  }
  return text;
}

function highlightSearch(text: string, term: string, isActiveLine: boolean): React.ReactNode {
  if (!term) return text;
  const lower = text.toLowerCase();
  const termLower = term.toLowerCase();
  let idx = lower.indexOf(termLower);
  if (idx === -1) return text;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  let matchCount = 0;

  while (idx !== -1) {
    if (idx > cursor) parts.push(text.slice(cursor, idx));
    const isActive = isActiveLine && matchCount === 0;
    parts.push(
      <span key={key++} className={`overlay${isActive ? " active" : ""}`}>
        {text.slice(idx, idx + term.length)}
      </span>,
    );
    matchCount++;
    cursor = idx + term.length;
    idx = lower.indexOf(termLower, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const LogViewer = observer(function LogViewer({ tab, workloadScope, appIdentity }: LogViewerProps) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0);
  const [filterLevel, setFilterLevel] = useState("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [showToBottom, setShowToBottom] = useState(false);
  const [listHeight, setListHeight] = useState(400);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  // Pod/container metadata
  const [podContainers, setPodContainers] = useState<ContainerInfo[]>([]);
  const [siblingPods, setSiblingPods] = useState<string[]>([]);
  const [ownerDisplay, setOwnerDisplay] = useState<{ kind: string; name: string } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<FixedSizeList>(null);
  const streamRef = useRef<StreamHandle | null>(null);
  const prevCountRef = useRef(0);
  const pendingRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadMoreLockRef = useRef(false);

  // Build config from stored patterns
  const storedPatterns: StoredPattern[] = patternManagerStore.getStoredPatterns(tab.namespace, workloadScope, appIdentity);
  const config: LogViewerConfig = useMemo(
    () => buildConfigFromPatterns(storedPatterns),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storedPatterns.map((p) => p.regex).join(",")],
  );

  // Fetch pod metadata on mount for container/pod selectors
  useEffect(() => {
    let cancelled = false;

    async function fetchPodMeta() {
      try {
        const api = Renderer.K8sApi.podsApi as any;
        const pod = await api.request.get(`/api/v1/namespaces/${tab.namespace}/pods/${tab.podName}`);
        if (cancelled) return;

        // Container list
        const containers = extractContainers(pod);
        setPodContainers(containers);

        // Owner reference
        const refs: any[] = pod.metadata?.ownerReferences || [];
        const primaryOwner = refs.find((r: any) => r.controller) || refs[0];
        if (primaryOwner) {
          setOwnerDisplay({ kind: primaryOwner.kind, name: primaryOwner.name });

          // Sibling pods with same owner
          try {
            const allPods = await api.request.get(`/api/v1/namespaces/${tab.namespace}/pods`);
            if (cancelled) return;
            const siblings = (allPods?.items || [])
              .filter((p: any) => {
                const podOwners: any[] = p.metadata?.ownerReferences || [];
                return podOwners.some((o: any) => o.uid === primaryOwner.uid);
              })
              .map((p: any) => p.metadata?.name)
              .filter(Boolean) as string[];
            setSiblingPods(siblings);
          } catch { /* ignore sibling fetch failure */ }
        } else if (tab.ownerRef) {
          setOwnerDisplay(tab.ownerRef);
        }
      } catch { /* pod fetch may fail for terminated pods */ }
    }

    fetchPodMeta();
    return () => { cancelled = true; };
  }, [tab.namespace, tab.podName]);

  // ResizeObserver for dynamic list height
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setListHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.stop();
      streamRef.current = null;
    }
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (pendingRef.current) {
      setContent((prev) => trimToMax(prev + pendingRef.current));
      pendingRef.current = "";
    }
  }, []);

  const fetchContent = useCallback(async () => {
    stopStream();
    setLoading(true);
    setError(null);
    loadMoreLockRef.current = false;

    if (tab.showPrevious) {
      // Previous container logs — one-shot, no streaming
      try {
        const result = await getPodLogs(tab.namespace, tab.podName, tab.container, tab.tailLines, true, true);
        setContent(result);
      } catch (err: any) {
        setError(err?.message || "No previous logs available (container may not have restarted)");
      } finally {
        setLoading(false);
      }
    } else {
      // Live streaming
      setContent("");
      pendingRef.current = "";
      const handle = streamPodLogs(
        tab.namespace,
        tab.podName,
        tab.container,
        tab.tailLines,
        (newData) => {
          pendingRef.current += newData;
          if (!flushTimerRef.current) {
            flushTimerRef.current = setTimeout(() => {
              setContent((prev) => trimToMax(prev + pendingRef.current));
              pendingRef.current = "";
              flushTimerRef.current = null;
              setLoading(false);
            }, 200);
          }
        },
        (err) => {
          setError(err.message);
          setLoading(false);
        },
        false,
        true,
      );
      streamRef.current = handle;
    }
  }, [tab.namespace, tab.podName, tab.container, tab.tailLines, tab.showPrevious, stopStream]);

  // Fetch on mount and when deps change
  useEffect(() => {
    fetchContent();
    return () => stopStream();
  }, [fetchContent, stopStream]);

  // Parse and classify lines
  const parsedLines: ParsedLine[] = useMemo(() => {
    return content
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line, i) => {
        const { timestamp, text } = parseTimestampFromLine(line);
        const level = config.classifyLine(text);
        const displayText = tab.showTimestamps && timestamp
          ? `${timestamp} ${text}`
          : text;
        return { lineNumber: i + 1, rawTimestamp: timestamp, text, level, displayText };
      });
  }, [content, config, tab.showTimestamps]);

  // First timestamp for "Logs from" display
  const firstTimestamp = useMemo(() => {
    for (const line of parsedLines) {
      if (line.rawTimestamp) {
        const d = new Date(line.rawTimestamp);
        if (!isNaN(d.getTime())) return d;
      }
    }
    return undefined;
  }, [parsedLines]);

  // Filter lines
  const filteredLines = useMemo(() => {
    return parsedLines.filter((line) => {
      if (filterLevel !== "all") {
        const opt = config.filterOptions.find((o) => o.value === filterLevel);
        if (opt?.matchLevels && !opt.matchLevels.includes(line.level)) return false;
      }
      if (searchTerm && !line.displayText.toLowerCase().includes(searchTerm.toLowerCase())) return false;
      return true;
    });
  }, [parsedLines, filterLevel, searchTerm, config.filterOptions]);

  // Search match indices
  const matchingLineIndices = useMemo(() => {
    if (!searchTerm) return [];
    const lower = searchTerm.toLowerCase();
    return filteredLines
      .map((line, i) => (line.displayText.toLowerCase().includes(lower) ? i : -1))
      .filter((i) => i !== -1);
  }, [filteredLines, searchTerm]);

  // Reset match index on search term change
  useEffect(() => {
    setCurrentMatchIdx(0);
  }, [searchTerm]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && filteredLines.length > 0 && filteredLines.length !== prevCountRef.current) {
      requestAnimationFrame(() => {
        listRef.current?.scrollToItem(filteredLines.length - 1, "end");
      });
    }
    prevCountRef.current = filteredLines.length;
  }, [filteredLines.length, autoScroll]);

  const goToMatch = useCallback(
    (idx: number) => {
      if (matchingLineIndices.length === 0) return;
      // Wrap around
      let clamped = idx;
      if (clamped < 0) clamped = matchingLineIndices.length - 1;
      if (clamped >= matchingLineIndices.length) clamped = 0;
      setCurrentMatchIdx(clamped);
      listRef.current?.scrollToItem(matchingLineIndices[clamped], "center");
    },
    [matchingLineIndices],
  );

  const scrollToBottom = () => {
    listRef.current?.scrollToItem(filteredLines.length - 1, "end");
    setAutoScroll(true);
    setShowToBottom(false);
  };

  const handleListScroll = useCallback(
    ({ scrollOffset, scrollUpdateWasRequested }: { scrollOffset: number; scrollUpdateWasRequested: boolean }) => {
      if (scrollUpdateWasRequested) return;
      const totalHeight = filteredLines.length * ROW_HEIGHT;
      const bottomDistance = totalHeight - (scrollOffset + listHeight);
      const linesFromBottom = bottomDistance / ROW_HEIGHT;
      setAutoScroll(linesFromBottom < 2);
      setShowToBottom(linesFromBottom > 100);

      // Load more on scroll to top
      if (scrollOffset === 0 && filteredLines.length > 0 && !loadMoreLockRef.current) {
        loadMoreLockRef.current = true;
        logPanelStore.setTailLines(tab.id, tab.tailLines + LOAD_MORE_INCREMENT);
      }
    },
    [filteredLines.length, listHeight, tab.id, tab.tailLines],
  );

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) goToMatch(currentMatchIdx - 1);
        else goToMatch(currentMatchIdx + 1);
      }
    },
    [goToMatch, currentMatchIdx],
  );

  // Level counts for stats and filter labels
  const levelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const line of parsedLines) {
      counts.set(line.level, (counts.get(line.level) || 0) + 1);
    }
    return counts;
  }, [parsedLines]);

  const getLineClassName = (level: string): string => {
    const def = config.levels.find((l) => l.id === level);
    return def?.cssClass ? `LogRow ${def.cssClass}` : "LogRow";
  };

  const isFollowing = !tab.showPrevious && streamRef.current !== null;

  const regularContainers = podContainers.filter((c) => !c.isInit);
  const initContainers = podContainers.filter((c) => c.isInit);

  // Pod/container change
  const handlePodChange = useCallback(
    (newPod: string) => {
      if (newPod !== tab.podName) {
        logPanelStore.openTab(tab.namespace, newPod, tab.container, tab.isInit, workloadScope, appIdentity, tab.ownerRef);
      }
    },
    [tab, workloadScope, appIdentity],
  );

  const handleContainerChange = useCallback(
    (newContainer: string) => {
      if (newContainer !== tab.container) {
        const ci = podContainers.find((c) => c.name === newContainer);
        logPanelStore.openTab(tab.namespace, tab.podName, newContainer, ci?.isInit ?? false, workloadScope, appIdentity, tab.ownerRef);
      }
    },
    [tab, podContainers, workloadScope, appIdentity],
  );

  // Download helpers
  const triggerDownload = (text: string, filename: string) => {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadVisibleLogs = useCallback(() => {
    const text = filteredLines.map((l) => l.displayText).join("\n");
    triggerDownload(text, `${tab.podName}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.log`);
  }, [filteredLines, tab.podName]);

  const showFeedback = useCallback((msg: string) => {
    setActionFeedback(msg);
    setTimeout(() => setActionFeedback(null), 2000);
  }, []);

  const downloadAllLogs = useCallback(async () => {
    try {
      const result = await getPodLogs(tab.namespace, tab.podName, tab.container, 0, tab.showPrevious, false);
      triggerDownload(result, `${tab.podName}-${tab.container}-all.log`);
    } catch {
      showFeedback("Download failed");
    }
  }, [tab, showFeedback]);

  const handleCopyVisible = useCallback(() => {
    const text = filteredLines.map((l) => l.displayText).join("\n");
    navigator.clipboard.writeText(text).then(
      () => showFeedback("Copied!"),
      () => showFeedback("Copy failed"),
    );
  }, [filteredLines, showFeedback]);

  const Row = useCallback(
    ({ index, style }: { index: number; style: React.CSSProperties }) => {
      const line = filteredLines[index];
      if (!line) return null;

      const isActiveMatchLine = matchingLineIndices[currentMatchIdx] === index;
      const isAnyMatch = searchTerm && line.displayText.toLowerCase().includes(searchTerm.toLowerCase());
      const hasAnsi = line.displayText.includes("\x1b[");

      const className = [
        getLineClassName(line.level),
        isAnyMatch ? "LogRow--search-match" : "",
        isActiveMatchLine ? "LogRow--search-match--active" : "",
      ].filter(Boolean).join(" ");

      if (hasAnsi) {
        const rawHtml = ansiUp.ansi_to_html(escapeHtml(line.displayText));
        const html = DOMPurify.sanitize(rawHtml, { ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["style"] });
        return (
          <div style={style} className={className} dangerouslySetInnerHTML={{ __html: html }} />
        );
      }

      return (
        <div style={style} className={className}>
          {highlightSearch(line.displayText, searchTerm, isActiveMatchLine)}
        </div>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredLines, searchTerm, currentMatchIdx, matchingLineIndices, config.levels],
  );

  return (
    <div className="flai-log-viewer">
      {/* ─── Zone 1: InfoPanel ─── */}
      <div className="flai-log-viewer__info-panel">
        <span className="flai-log-viewer__badge">{tab.namespace}</span>

        {ownerDisplay && (
          <span className="flai-log-viewer__badge flai-log-viewer__badge--owner">
            {ownerDisplay.kind} {ownerDisplay.name}
          </span>
        )}

        {/* Pod selector */}
        <label className="flai-log-viewer__field">
          <span className="flai-log-viewer__field-label">Pod</span>
          <select
            className="flai-log-viewer__select"
            value={tab.podName}
            onChange={(e) => handlePodChange(e.target.value)}
          >
            {siblingPods.length > 0
              ? siblingPods.map((p) => <option key={p} value={p}>{p}</option>)
              : <option value={tab.podName}>{tab.podName}</option>
            }
          </select>
        </label>

        {/* Container selector */}
        <label className="flai-log-viewer__field">
          <span className="flai-log-viewer__field-label">Container</span>
          <select
            className="flai-log-viewer__select"
            value={tab.container}
            onChange={(e) => handleContainerChange(e.target.value)}
          >
            {podContainers.length > 0 ? (
              <>
                {regularContainers.length > 0 && (
                  <optgroup label="Containers">
                    {regularContainers.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </optgroup>
                )}
                {initContainers.length > 0 && (
                  <optgroup label="Init Containers">
                    {initContainers.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </optgroup>
                )}
              </>
            ) : (
              <option value={tab.container}>{tab.container}</option>
            )}
          </select>
        </label>

        {/* LIVE badge */}
        {isFollowing && (
          <span className="flai-log-viewer__follow-badge">
            <span className="flai-log-viewer__follow-dot" />
            LIVE
          </span>
        )}

        <span className="flai-log-viewer__spacer" />

        {/* Search with counter and navigation */}
        <div className="flai-log-viewer__search-wrapper">
          <input
            className="flai-log-viewer__search"
            type="text"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          {searchTerm && (
            <span className={`flai-log-viewer__search-counter ${matchingLineIndices.length === 0 ? "flai-log-viewer__search-counter--no-match" : ""}`}>
              {matchingLineIndices.length > 0
                ? `${currentMatchIdx + 1} / ${matchingLineIndices.length}`
                : "0 / 0"}
            </span>
          )}
        </div>
        <button
          type="button"
          className="flai-log-viewer__nav-btn"
          onClick={() => goToMatch(currentMatchIdx - 1)}
          disabled={matchingLineIndices.length === 0}
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
        >
          <ArrowUp />
        </button>
        <button
          type="button"
          className="flai-log-viewer__nav-btn"
          onClick={() => goToMatch(currentMatchIdx + 1)}
          disabled={matchingLineIndices.length === 0}
          title="Next match (Enter)"
          aria-label="Next match"
        >
          <ArrowDown />
        </button>
      </div>

      {/* ─── Zone 2: LogList ─── */}
      <div className="flai-log-viewer__list-container LogList" ref={containerRef}>
        {/* "To Bottom" floating button */}
        {showToBottom && (
          <button
            type="button"
            className="flai-log-viewer__to-bottom"
            onClick={scrollToBottom}
            title="Scroll to bottom"
          >
            <DownloadArrow />
            <span>To bottom</span>
          </button>
        )}

        {/* Loading state */}
        {loading && !content && (
          <div className="flai-log-viewer__empty-state" aria-live="polite">
            <SimpleSpinner />
            <div className="flai-log-viewer__empty-title">Connecting to log stream...</div>
            <div className="flai-log-viewer__empty-subtitle">
              {tab.podName}/{tab.container}
            </div>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="flai-log-viewer__error-state" role="alert">
            <div className="flai-log-viewer__error-icon">{"\u26A0"}</div>
            <div className="flai-log-viewer__error-message">{error}</div>
            <button
              type="button"
              className="flai-btn flai-btn--secondary"
              onClick={fetchContent}
            >
              {"\u21BB"} Retry
            </button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && content.length === 0 && (
          <div className="flai-log-viewer__empty-state">
            <div className="flai-log-viewer__empty-title">
              There are no logs available for container {tab.container}
            </div>
          </div>
        )}

        {/* Virtualized log list */}
        <FixedSizeList
          ref={listRef}
          height={listHeight}
          itemCount={filteredLines.length}
          itemSize={ROW_HEIGHT}
          width="100%"
          onScroll={handleListScroll}
          overscanCount={20}
        >
          {Row}
        </FixedSizeList>
      </div>

      {/* ─── Zone 3: LogControls ─── */}
      <div className="flai-log-viewer__controls">
        <div className="flai-log-viewer__controls-left">
          {firstTimestamp && (
            <span className="flai-log-viewer__log-date">
              Logs from <strong>{firstTimestamp.toLocaleString()}</strong>
            </span>
          )}

          <label className="flai-log-viewer__toggle">
            <input
              type="checkbox"
              checked={tab.showTimestamps}
              onChange={(e) => logPanelStore.setShowTimestamps(tab.id, e.target.checked)}
            />
            Show timestamps
          </label>

          <label className="flai-log-viewer__toggle">
            <input
              type="checkbox"
              checked={tab.showPrevious}
              onChange={(e) => logPanelStore.setShowPrevious(tab.id, e.target.checked)}
            />
            Show previous terminated container
          </label>
        </div>

        <div className="flai-log-viewer__controls-right">
          {/* Stats badges */}
          {config.stats.map((stat) => {
            const count = stat.matchLevels.reduce((sum, l) => sum + (levelCounts.get(l) || 0), 0);
            return (
              <span key={stat.label} className={`flai-log-viewer__stat ${stat.cssStatClass}`}>
                <span className="flai-log-viewer__stat-count">{count}</span>
                <span className="flai-log-viewer__stat-label">{stat.label}</span>
              </span>
            );
          })}
          <span className="flai-log-viewer__stat">
            <span className="flai-log-viewer__stat-count">{parsedLines.length.toLocaleString()}</span>
            <span className="flai-log-viewer__stat-label">lines</span>
          </span>

          {/* Level filter */}
          <select
            className="flai-log-viewer__select"
            value={filterLevel}
            onChange={(e) => setFilterLevel(e.target.value)}
            title="Filter by log level"
          >
            {config.filterOptions.map((opt) => {
              const count = opt.matchLevels
                ? opt.matchLevels.reduce((sum, l) => sum + (levelCounts.get(l) || 0), 0)
                : parsedLines.length;
              return (
                <option key={opt.value} value={opt.value}>
                  {opt.label} ({count.toLocaleString()})
                </option>
              );
            })}
          </select>

          {/* Copy */}
          <button type="button" className="flai-log-viewer__btn" onClick={handleCopyVisible} title="Copy visible logs">
            Copy
          </button>

          {/* Download dropdown */}
          <button type="button" className="flai-log-viewer__btn" onClick={downloadVisibleLogs} title="Download visible logs">
            {"\u2913"} Visible
          </button>
          <button type="button" className="flai-log-viewer__btn" onClick={downloadAllLogs} title="Download all logs (full fetch)">
            {"\u2913"} All
          </button>

          {actionFeedback && (
            <span className="flai-log-viewer__feedback" role="status">{actionFeedback}</span>
          )}
        </div>
      </div>
    </div>
  );
});
