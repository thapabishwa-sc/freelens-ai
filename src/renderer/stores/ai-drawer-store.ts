import { makeAutoObservable, runInAction } from "mobx";
import { Renderer } from "@freelensapp/extensions";
import {
  analyzeResource,
  getCachedAnalysis,
  invalidateCache,
  type AnalysisState,
} from "../services/analyze";
import {
  isClaudeAvailable,
  loadPersistedAuth,
  clearAuth,
  clearPersistedAuth,
} from "../services/claude-client";

type KubeObject = Renderer.K8sApi.KubeObject;

class AIDrawerStore {
  isOpen = false;
  targetObject: KubeObject | null = null;
  targetKind = "";
  analysisState: AnalysisState = { status: "idle" };
  model: "haiku" | "sonnet" = "haiku";
  isAuthenticated = false;
  mode: "resource" | "log" = "resource";
  logNamespace = "";
  logPodName = "";
  logContainer = "";
  private abortController: AbortController | null = null;
  private lastAnalyzeTime = 0;

  constructor() {
    makeAutoObservable(this);
    loadPersistedAuth();
    this.isAuthenticated = isClaudeAvailable();
  }

  private get uid(): string {
    const meta = (this.targetObject as any)?.metadata || {};
    return meta.uid || `${this.targetKind}/${meta.namespace || ""}/${meta.name}`;
  }

  open(object: KubeObject, kind: string) {
    this.targetObject = object;
    this.targetKind = kind;
    this.mode = "resource";
    this.isOpen = true;

    // Restore from cache if available
    const cached = getCachedAnalysis(this.uid);
    if (cached) {
      this.analysisState = { status: "success", data: cached.data, cachedAt: cached.timestamp };
    } else {
      this.analysisState = { status: "idle" };
    }

    // Re-check auth
    loadPersistedAuth();
    this.isAuthenticated = isClaudeAvailable();
  }

  openForLogAnalysis(pod: KubeObject, namespace: string, podName: string, container: string) {
    this.targetObject = pod;
    this.targetKind = "Pod";
    this.mode = "log";
    this.logNamespace = namespace;
    this.logPodName = podName;
    this.logContainer = container;
    this.isOpen = true;
    this.analysisState = { status: "idle" };

    loadPersistedAuth();
    this.isAuthenticated = isClaudeAvailable();
  }

  close() {
    this.isOpen = false;
    this.mode = "resource";
    // Abort any in-flight analysis
    this.abortController?.abort();
    this.abortController = null;
  }

  setModel(model: "haiku" | "sonnet") {
    this.model = model;
  }

  setAuthenticated(value: boolean) {
    this.isAuthenticated = value;
  }

  async analyze(force?: boolean) {
    if (!this.targetObject) return;

    // Debounce: skip if started < 2s ago (unless forced)
    const now = Date.now();
    if (!force && now - this.lastAnalyzeTime < 2000) return;
    this.lastAnalyzeTime = now;

    const uid = this.uid;
    if (force) invalidateCache(uid);

    // Abort previous request
    this.abortController?.abort();
    const ctrl = new AbortController();
    this.abortController = ctrl;

    runInAction(() => {
      this.analysisState = { status: "loading" };
    });

    try {
      const data = await analyzeResource(this.targetKind, this.targetObject, this.model, ctrl.signal);
      // Guard: if a new analysis started (or drawer closed), discard this result
      if (this.abortController !== ctrl) return;
      runInAction(() => {
        this.analysisState = { status: "success", data, cachedAt: Date.now() };
      });
    } catch (err: any) {
      if (err.name === "AbortError") return;
      if (this.abortController !== ctrl) return;
      runInAction(() => {
        this.analysisState = { status: "error", error: err.message || "Analysis failed" };
      });
    } finally {
      if (this.abortController === ctrl) {
        this.abortController = null;
      }
    }
  }

  handleLogout() {
    clearAuth();
    clearPersistedAuth();
    this.isAuthenticated = false;
    this.analysisState = { status: "idle" };
  }
}

export const aiDrawerStore = new AIDrawerStore();
