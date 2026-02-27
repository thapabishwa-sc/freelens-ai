import { makeAutoObservable } from "mobx";
import type { OwnerRef } from "../utils/pod-utils";

export interface LogTab {
  id: string;
  podName: string;
  namespace: string;
  container: string;
  isInit: boolean;
  /** Workload scope key, e.g. "deploy:my-app" or "sts:redis" */
  workloadScope?: string;
  /** Cross-namespace app identity from pod labels, e.g. "app:nginx" */
  appIdentity?: string;
  /** Owner reference from pod metadata (for sibling pod listing) */
  ownerRef?: OwnerRef;
  /** Show RFC3339 timestamp prefix on each line */
  showTimestamps: boolean;
  /** Fetch logs from previously terminated container */
  showPrevious: boolean;
  /** Number of tail lines to fetch */
  tailLines: number;
}

function makeTabId(namespace: string, podName: string, container: string): string {
  return `${namespace}/${podName}/${container}`;
}

class LogPanelStore {
  isOpen = false;
  minimized = false;
  tabs: LogTab[] = [];
  activeTabId = "";
  sidebarVisible = false;

  constructor() {
    makeAutoObservable(this);
  }

  /** Open a tab for a specific container. If already open, just activate it. */
  openTab(
    namespace: string,
    podName: string,
    container: string,
    isInit = false,
    workloadScope?: string,
    appIdentity?: string,
    ownerRef?: OwnerRef,
  ) {
    const id = makeTabId(namespace, podName, container);
    const existing = this.tabs.find((t) => t.id === id);

    if (existing) {
      this.activeTabId = id;
    } else {
      this.tabs.push({
        id,
        podName,
        namespace,
        container,
        isInit,
        workloadScope,
        appIdentity,
        ownerRef,
        showTimestamps: false,
        showPrevious: false,
        tailLines: 500,
      });
      this.activeTabId = id;
    }

    this.isOpen = true;
    this.minimized = false;
  }

  /** Update showTimestamps for a tab */
  setShowTimestamps(id: string, val: boolean) {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab) tab.showTimestamps = val;
  }

  /** Update showPrevious for a tab */
  setShowPrevious(id: string, val: boolean) {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab) tab.showPrevious = val;
  }

  /** Update tailLines for a tab (capped at 10,000) */
  setTailLines(id: string, val: number) {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab) tab.tailLines = Math.min(val, 10_000);
  }

  /** Close a specific tab */
  closeTab(id: string) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;

    this.tabs.splice(idx, 1);

    if (this.activeTabId === id) {
      if (this.tabs.length === 0) {
        this.activeTabId = "";
        this.isOpen = false;
      } else {
        const newIdx = Math.min(idx, this.tabs.length - 1);
        this.activeTabId = this.tabs[newIdx].id;
      }
    }
  }

  /** Close all tabs and the panel */
  close() {
    this.tabs = [];
    this.activeTabId = "";
    this.isOpen = false;
    this.minimized = false;
  }

  /** Hide the panel but keep tabs alive */
  hide() {
    this.minimized = true;
  }

  /** Restore from minimized state */
  restore() {
    this.minimized = false;
  }

  /** Toggle AI insights sidebar visibility */
  toggleSidebar() {
    this.sidebarVisible = !this.sidebarVisible;
  }

  /** Get the active tab info */
  get activeTab(): LogTab | undefined {
    return this.tabs.find((t) => t.id === this.activeTabId);
  }
}

export const logPanelStore = new LogPanelStore();
