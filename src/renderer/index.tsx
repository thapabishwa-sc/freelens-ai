import ReactDOM from "react-dom";
import { Renderer } from "@freelensapp/extensions";
import { autorun, type IReactionDisposer } from "mobx";
import { AITriggerButton } from "./components/ai-trigger-button";
import { AIMenuItem } from "./components/ai-menu-item";
import { AILogMenuItem } from "./components/ai-log-menu-item";
import { AIDrawer } from "./components/ai-drawer";
import { LogBottomPanel } from "./components/log-bottom-panel";
import { invalidateCache } from "./services/analyze";
import { clearLogCache } from "./services/log-analyze";
import { logAnalysisStore } from "./stores/log-analysis-store";
import { logger } from "./services/logger";
import stylesInline from "./styles/ai-panel.scss?inline";
import drawerStylesInline from "./styles/ai-drawer.scss?inline";
import graphStylesInline from "./styles/relationship-graph.scss?inline";
import logStylesInline from "./styles/log-analysis.scss?inline";
import logViewerStylesInline from "./styles/log-viewer.scss?inline";

const STYLE_ID = "freelens-ai-styles";
const DRAWER_STYLE_ID = "freelens-ai-drawer-styles";
const GRAPH_STYLE_ID = "freelens-ai-graph-styles";
const LOG_STYLE_ID = "freelens-ai-log-styles";
const LOG_VIEWER_STYLE_ID = "freelens-ai-log-viewer-styles";
const THEME_VARS_ID = "freelens-ai-theme-vars";
const DRAWER_ROOT_ID = "freelens-ai-drawer-root";
const LOG_PANEL_ROOT_ID = "freelens-ai-log-panel-root";

// Built-in Kubernetes resource kinds
const BUILTIN_KINDS = [
  { kind: "Pod", apiVersions: ["v1"] },
  { kind: "Node", apiVersions: ["v1"] },
  { kind: "Service", apiVersions: ["v1"] },
  { kind: "Deployment", apiVersions: ["apps/v1"] },
  { kind: "StatefulSet", apiVersions: ["apps/v1"] },
  { kind: "DaemonSet", apiVersions: ["apps/v1"] },
  { kind: "ReplicaSet", apiVersions: ["apps/v1"] },
  { kind: "Job", apiVersions: ["batch/v1"] },
  { kind: "CronJob", apiVersions: ["batch/v1"] },
  { kind: "Ingress", apiVersions: ["networking.k8s.io/v1"] },
  { kind: "ConfigMap", apiVersions: ["v1"] },
  { kind: "Secret", apiVersions: ["v1"] },
  { kind: "PersistentVolumeClaim", apiVersions: ["v1"] },
  { kind: "PersistentVolume", apiVersions: ["v1"] },
  { kind: "NetworkPolicy", apiVersions: ["networking.k8s.io/v1"] },
  { kind: "Namespace", apiVersions: ["v1"] },
  { kind: "ServiceAccount", apiVersions: ["v1"] },
  { kind: "Role", apiVersions: ["rbac.authorization.k8s.io/v1"] },
  { kind: "RoleBinding", apiVersions: ["rbac.authorization.k8s.io/v1"] },
  { kind: "ClusterRole", apiVersions: ["rbac.authorization.k8s.io/v1"] },
  { kind: "ClusterRoleBinding", apiVersions: ["rbac.authorization.k8s.io/v1"] },
  { kind: "StorageClass", apiVersions: ["storage.k8s.io/v1"] },
  { kind: "HorizontalPodAutoscaler", apiVersions: ["autoscaling/v2", "autoscaling/v1"] },
  { kind: "PodDisruptionBudget", apiVersions: ["policy/v1"] },
  { kind: "ResourceQuota", apiVersions: ["v1"] },
  { kind: "LimitRange", apiVersions: ["v1"] },
  { kind: "Endpoints", apiVersions: ["v1"] },
  { kind: "EndpointSlice", apiVersions: ["discovery.k8s.io/v1"] },
];

function makeDetailRegistration(kind: string, apiVersions: string[]) {
  return {
    kind,
    apiVersions,
    priority: 100,
    components: { Details: AITriggerButton },
  };
}

function makeMenuRegistration(kind: string, apiVersions: string[]) {
  return {
    kind,
    apiVersions,
    components: { MenuItem: AIMenuItem },
  };
}

export default class FreeLensAIRenderer extends Renderer.LensExtension {
  private _disposeTheme?: IReactionDisposer;

  kubeObjectDetailItems = BUILTIN_KINDS.map(({ kind, apiVersions }) =>
    makeDetailRegistration(kind, apiVersions)
  );

  kubeObjectMenuItems = [
    ...BUILTIN_KINDS.map(({ kind, apiVersions }) =>
      makeMenuRegistration(kind, apiVersions)
    ),
    // AI Log Analysis menu item for Pods
    {
      kind: "Pod",
      apiVersions: ["v1"],
      components: { MenuItem: AILogMenuItem },
    },
  ];

  async onActivate(): Promise<void> {
    // Clean up stale styles / elements
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(DRAWER_STYLE_ID)?.remove();
    document.getElementById(GRAPH_STYLE_ID)?.remove();
    document.getElementById(LOG_STYLE_ID)?.remove();
    document.getElementById(LOG_VIEWER_STYLE_ID)?.remove();
    document.getElementById(THEME_VARS_ID)?.remove();
    this._disposeTheme?.();
    this.cleanupAll();

    // Inject styles
    const styleEntries: [string, string][] = [
      [STYLE_ID, stylesInline],
      [DRAWER_STYLE_ID, drawerStylesInline],
      [GRAPH_STYLE_ID, graphStylesInline],
      [LOG_STYLE_ID, logStylesInline],
      [LOG_VIEWER_STYLE_ID, logViewerStylesInline],
    ];
    for (const [id, css] of styleEntries) {
      const el = document.createElement("style");
      el.id = id;
      el.textContent = css;
      document.head.appendChild(el);
    }

    // Sync FreeLens theme colors as CSS custom properties
    this._disposeTheme = autorun(() => {
      const theme = Renderer.Theme.activeTheme.get();
      const colors = theme.colors as Record<string, string>;
      const vars = Object.entries(colors)
        .map(([name, value]) => `--${name}: ${value};`)
        .join("\n  ");
      const css = `:root {\n  ${vars}\n}`;

      let themeEl = document.getElementById(THEME_VARS_ID) as HTMLStyleElement | null;
      if (!themeEl) {
        themeEl = document.createElement("style");
        themeEl.id = THEME_VARS_ID;
        document.head.appendChild(themeEl);
      }
      themeEl.textContent = css;
    });

    // Mount the global AI drawer
    const drawerRoot = document.createElement("div");
    drawerRoot.id = DRAWER_ROOT_ID;
    document.body.appendChild(drawerRoot);
    ReactDOM.render(<AIDrawer />, drawerRoot);

    // Mount the log bottom panel
    const logPanelRoot = document.createElement("div");
    logPanelRoot.id = LOG_PANEL_ROOT_ID;
    document.body.appendChild(logPanelRoot);
    ReactDOM.render(<LogBottomPanel />, logPanelRoot);

    // Discover CRDs and register AI panel + menu item for each
    this.discoverCRDs().catch((err) => {
      logger.warn("CRD discovery failed:", err.message);
    });
  }

  async onDeactivate(): Promise<void> {
    this._disposeTheme?.();
    this._disposeTheme = undefined;
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(DRAWER_STYLE_ID)?.remove();
    document.getElementById(GRAPH_STYLE_ID)?.remove();
    document.getElementById(LOG_STYLE_ID)?.remove();
    document.getElementById(LOG_VIEWER_STYLE_ID)?.remove();
    document.getElementById(THEME_VARS_ID)?.remove();
    this.cleanupAll();

    // Clear all caches and in-flight requests
    invalidateCache();
    clearLogCache();
    logAnalysisStore.clearAll();
  }

  private cleanupAll() {
    const drawerRoot = document.getElementById(DRAWER_ROOT_ID);
    if (drawerRoot) {
      ReactDOM.unmountComponentAtNode(drawerRoot);
      drawerRoot.remove();
    }
    const logPanelRoot = document.getElementById(LOG_PANEL_ROOT_ID);
    if (logPanelRoot) {
      ReactDOM.unmountComponentAtNode(logPanelRoot);
      logPanelRoot.remove();
    }
  }

  private async discoverCRDs(): Promise<void> {
    try {
      const api = Renderer.K8sApi.podsApi as any;
      const response = await api.request.get("/apis/apiextensions.k8s.io/v1/customresourcedefinitions");
      const items = response?.items || [];

      const registeredKinds = new Set(this.kubeObjectDetailItems.map((r: any) => r.kind));
      let added = 0;

      for (const crd of items) {
        const kind = crd.spec?.names?.kind;
        const group = crd.spec?.group;
        if (!kind || !group) continue;
        if (registeredKinds.has(kind)) continue;

        // Get all served versions
        const versions: string[] = (crd.spec?.versions || [])
          .filter((v: any) => v.served)
          .map((v: any) => `${group}/${v.name}`);

        if (versions.length === 0) continue;

        this.kubeObjectDetailItems.push(makeDetailRegistration(kind, versions));
        this.kubeObjectMenuItems.push(makeMenuRegistration(kind, versions));
        registeredKinds.add(kind);
        added++;
      }

      if (added > 0) {
        logger.info(`Registered AI panel for ${added} CRDs`);
      }
    } catch (err: any) {
      logger.warn("Could not discover CRDs:", err.message);
    }
  }
}
