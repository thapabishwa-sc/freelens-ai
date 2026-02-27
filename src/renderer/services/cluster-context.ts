import { Renderer } from "@freelensapp/extensions";

/**
 * Returns a stable identifier for the active FreeLens cluster.
 * Uses the kubeconfig context name as the primary key.
 * Falls back to "unknown" if no cluster is active.
 */
export function getActiveClusterId(): string {
  // 1. getActiveCluster() (FreeLens >=1.8)
  try {
    const cluster = (Renderer.Catalog as any).getActiveCluster?.();
    if (cluster?.contextName) return cluster.contextName;
  } catch { /* ignore */ }

  // 2. activeCluster observable
  try {
    const entity = (Renderer.Catalog as any).activeCluster?.get?.();
    if (entity?.spec?.kubeconfigContext) return entity.spec.kubeconfigContext;
  } catch { /* ignore */ }

  // 3. catalogEntities.activeEntity
  try {
    const entity = (Renderer.Catalog as any).catalogEntities?.activeEntity;
    if (entity?.spec?.kubeconfigContext) return entity.spec.kubeconfigContext;
  } catch { /* ignore */ }

  return "unknown";
}

/**
 * Returns [kubeconfigPath, contextName?] for kubectl invocations.
 * Extracted from log-stream.ts for reuse.
 */
export function getClusterKubeconfig(): { kubeconfigPath: string; contextName?: string } | null {
  // 1. getActiveCluster()
  try {
    const cluster = (Renderer.Catalog as any).getActiveCluster?.();
    if (cluster?.kubeConfigPath) {
      return { kubeconfigPath: cluster.kubeConfigPath, contextName: cluster.contextName };
    }
  } catch { /* ignore */ }

  // 2. activeCluster observable
  try {
    const entity = (Renderer.Catalog as any).activeCluster?.get?.();
    if (entity?.spec?.kubeconfigPath) {
      return { kubeconfigPath: entity.spec.kubeconfigPath, contextName: entity.spec.kubeconfigContext };
    }
  } catch { /* ignore */ }

  // 3. catalogEntities.activeEntity
  try {
    const entity = (Renderer.Catalog as any).catalogEntities?.activeEntity;
    if (entity?.spec?.kubeconfigPath) {
      return { kubeconfigPath: entity.spec.kubeconfigPath, contextName: entity.spec.kubeconfigContext };
    }
  } catch { /* ignore */ }

  return null;
}
