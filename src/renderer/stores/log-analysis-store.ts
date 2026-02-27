import { makeAutoObservable, runInAction } from "mobx";
import { analyzeLogsFn, type LogAnalysisState } from "../services/log-analyze";
import { isClaudeAvailable } from "../services/claude-client";

class LogAnalysisStore {
  /** Map of "namespace/podName/container?" → analysis state */
  analyses = new Map<string, LogAnalysisState>();

  /** Currently active model */
  model: "haiku" | "sonnet" = "haiku";

  /** Active abort controllers by key */
  private abortControllers = new Map<string, AbortController>();

  /** Debounce: last analysis start time per key */
  private lastAnalysisTime = new Map<string, number>();

  constructor() {
    makeAutoObservable(this);
  }

  private makeKey(namespace: string, podName: string, container?: string): string {
    return `${namespace}/${podName}${container ? `/${container}` : ""}`;
  }

  getState(namespace: string, podName: string, container?: string): LogAnalysisState {
    return this.analyses.get(this.makeKey(namespace, podName, container)) || { status: "idle" };
  }

  /** Abort any in-flight analysis for the given key */
  abort(namespace: string, podName: string, container?: string) {
    const key = this.makeKey(namespace, podName, container);
    this.abortControllers.get(key)?.abort();
    this.abortControllers.delete(key);
  }

  /** Abort all in-flight analyses */
  abortAll() {
    for (const ctrl of this.abortControllers.values()) {
      ctrl.abort();
    }
    this.abortControllers.clear();
  }

  /** Clear all state (for extension deactivation / cluster switch) */
  clearAll() {
    this.abortAll();
    this.analyses.clear();
    this.lastAnalysisTime.clear();
  }

  async analyze(namespace: string, podName: string, container?: string, force?: boolean) {
    if (!isClaudeAvailable()) return;

    const key = this.makeKey(namespace, podName, container);

    // Debounce: skip if analysis started < 2s ago (unless forced)
    const now = Date.now();
    if (!force && now - (this.lastAnalysisTime.get(key) || 0) < 2000) return;
    this.lastAnalysisTime.set(key, now);

    // Abort any previous request for the same key
    this.abortControllers.get(key)?.abort();

    const ctrl = new AbortController();
    this.abortControllers.set(key, ctrl);

    runInAction(() => {
      this.analyses.set(key, { status: "loading" });
    });

    try {
      const data = await analyzeLogsFn(namespace, podName, container, this.model, force, ctrl.signal);
      runInAction(() => {
        this.analyses.set(key, { status: "success", data, cachedAt: Date.now() });
      });
    } catch (err: any) {
      if (err.name === "AbortError") return; // Silently ignore aborted requests
      runInAction(() => {
        this.analyses.set(key, { status: "error", error: err.message || "Log analysis failed" });
      });
    } finally {
      this.abortControllers.delete(key);
    }
  }
}

export const logAnalysisStore = new LogAnalysisStore();
