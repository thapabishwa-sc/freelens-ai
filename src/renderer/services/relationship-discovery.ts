/**
 * Dynamic Kubernetes resource relationship discovery.
 *
 * At analysis time, discovers relationships by:
 * 1. Walking ownerReferences UP (this resource → parent → grandparent)
 * 2. Searching ownerReferences DOWN (find resources owned by this one)
 * 3. Resolving label selectors (Service → Pods, ServiceMonitor → Services)
 * 4. Following spec-level cross-references (Ingress → Service, ExternalSecret → SecretStore)
 *
 * All discovery is dynamic — no hardcoded CRD knowledge.
 */

import { Renderer } from "@freelensapp/extensions";
import { getConfig } from "./config";
import { logger } from "./logger";

// ── Types ──

export interface RelatedResource {
  kind: string;
  apiVersion: string;
  name: string;
  namespace?: string;
  relationship: string;     // e.g., "owner", "child", "selected-by-selector", "referenced-in-spec"
  status?: string;          // brief status summary
  detail?: string;          // additional detail (e.g., "3/3 ready")
}

export interface ResourceRelationships {
  owners: RelatedResource[];       // ownerRef chain going UP
  children: RelatedResource[];     // resources owned by this object (DOWN)
  selectorTargets: RelatedResource[]; // resources matched by this object's selectors
  specReferences: RelatedResource[];  // resources referenced in spec fields
}

// ── API helpers ──

async function apiGet(path: string): Promise<any> {
  const api = Renderer.K8sApi.podsApi as any;
  return api.request.get(path);
}

async function apiGetSafe(path: string): Promise<any | null> {
  try {
    return await apiGet(path);
  } catch {
    return null;
  }
}

// ── 1. Walk ownerReferences UP ──

async function walkOwnersUp(object: any, maxDepth = 5): Promise<RelatedResource[]> {
  const owners: RelatedResource[] = [];
  let current = object;

  for (let depth = 0; depth < maxDepth; depth++) {
    const refs = current?.metadata?.ownerReferences;
    if (!refs || refs.length === 0) break;

    for (const ref of refs) {
      const owner: RelatedResource = {
        kind: ref.kind,
        apiVersion: ref.apiVersion || "",
        name: ref.name,
        namespace: current.metadata?.namespace,
        relationship: depth === 0 ? "direct owner" : `owner (depth ${depth + 1})`,
      };

      // Try to fetch the owner to get its status and continue the chain
      const ownerObj = await resolveOwnerRef(ref, current.metadata?.namespace);
      if (ownerObj) {
        owner.status = summarizeStatus(ownerObj);
        // Continue walking from the first owner
        if (refs.indexOf(ref) === 0) {
          current = ownerObj;
        }
      }

      owners.push(owner);
    }

    // If we couldn't fetch the owner, stop walking
    if (current === object && depth === 0) break;
  }

  return owners;
}

async function resolveOwnerRef(ref: any, namespace?: string): Promise<any | null> {
  const apiVersion = ref.apiVersion || "v1";
  const kind = ref.kind;
  const name = ref.name;

  // Build the API path from apiVersion and kind
  const path = buildResourcePath(apiVersion, kind, namespace, name);
  if (!path) return null;

  return apiGetSafe(path);
}

// ── 2. Find children (resources owned by this object) ──

/**
 * Well-known resource types that commonly have ownerReferences.
 * Instead of scanning ALL API groups (which triggers 100+ API calls),
 * we check a focused list of resources likely to be children.
 */
const CHILD_SEARCH_PATHS: { groupVersion: string; resource: string; kind: string }[] = [
  // Core
  { groupVersion: "v1", resource: "pods", kind: "Pod" },
  { groupVersion: "v1", resource: "services", kind: "Service" },
  { groupVersion: "v1", resource: "configmaps", kind: "ConfigMap" },
  { groupVersion: "v1", resource: "secrets", kind: "Secret" },
  { groupVersion: "v1", resource: "persistentvolumeclaims", kind: "PersistentVolumeClaim" },
  { groupVersion: "v1", resource: "events", kind: "Event" },
  // Apps
  { groupVersion: "apps/v1", resource: "replicasets", kind: "ReplicaSet" },
  { groupVersion: "apps/v1", resource: "deployments", kind: "Deployment" },
  { groupVersion: "apps/v1", resource: "statefulsets", kind: "StatefulSet" },
  { groupVersion: "apps/v1", resource: "daemonsets", kind: "DaemonSet" },
  { groupVersion: "apps/v1", resource: "controllerrevisions", kind: "ControllerRevision" },
  // Batch
  { groupVersion: "batch/v1", resource: "jobs", kind: "Job" },
  { groupVersion: "batch/v1", resource: "cronjobs", kind: "CronJob" },
  // Networking
  { groupVersion: "networking.k8s.io/v1", resource: "ingresses", kind: "Ingress" },
  // Autoscaling
  { groupVersion: "autoscaling/v2", resource: "horizontalpodautoscalers", kind: "HorizontalPodAutoscaler" },
  // Policy
  { groupVersion: "policy/v1", resource: "poddisruptionbudgets", kind: "PodDisruptionBudget" },
  // cert-manager (common CRD)
  { groupVersion: "cert-manager.io/v1", resource: "certificates", kind: "Certificate" },
  { groupVersion: "cert-manager.io/v1", resource: "certificaterequests", kind: "CertificateRequest" },
  { groupVersion: "cert-manager.io/v1", resource: "orders", kind: "Order" },
  { groupVersion: "acme.cert-manager.io/v1", resource: "orders", kind: "Order" },
  { groupVersion: "acme.cert-manager.io/v1", resource: "challenges", kind: "Challenge" },
];

const BATCH_TIMEOUT_MS = 10_000; // 10s per batch — skip slow API groups

async function findChildren(object: any): Promise<RelatedResource[]> {
  const uid = object.metadata?.uid;
  const namespace = object.metadata?.namespace;
  if (!uid) return [];

  const children: RelatedResource[] = [];
  const maxChildren = getConfig().maxRelationshipChildren;
  const start = Date.now();

  // Search well-known resource types for ownerReference matches
  // Run searches in parallel (batched to limit concurrency)
  const batchSize = 5;
  for (let i = 0; i < CHILD_SEARCH_PATHS.length; i += batchSize) {
    const batch = CHILD_SEARCH_PATHS.slice(i, i + batchSize);

    // Wrap each batch with a timeout so a slow API group doesn't block discovery
    const results = await Promise.race([
      Promise.all(
        batch.map(async ({ groupVersion, resource, kind }) => {
          const basePath = groupVersion.includes("/")
            ? `/apis/${groupVersion}`
            : `/api/${groupVersion}`;
          const listPath = namespace
            ? `${basePath}/namespaces/${namespace}/${resource}?limit=100`
            : `${basePath}/${resource}?limit=100`;

          const result = await apiGetSafe(listPath);
          if (!result?.items) return [];

          return (result.items as any[])
            .filter((item: any) =>
              (item.metadata?.ownerReferences || []).some((ref: any) => ref.uid === uid)
            )
            .map((item: any) => ({
              kind: item.kind || kind,
              apiVersion: groupVersion,
              name: item.metadata?.name,
              namespace: item.metadata?.namespace,
              relationship: "child (owned)",
              status: summarizeStatus(item),
            } as RelatedResource));
        })
      ),
      new Promise<RelatedResource[][]>((_, reject) =>
        setTimeout(() => reject(new Error("batch timeout")), BATCH_TIMEOUT_MS)
      ),
    ]).catch(() => [] as RelatedResource[][]);

    for (const batchResults of results) {
      children.push(...batchResults);
    }

    if (children.length >= maxChildren) break;
  }

  // If the object's kind suggests it might own CRD resources not in the well-known list,
  // do a targeted search using the object's API group
  const objApiVersion = object.apiVersion || "";
  if (objApiVersion.includes("/") && !objApiVersion.startsWith("apps/") && !objApiVersion.startsWith("batch/")) {
    try {
      const resources = await discoverGroupResources(objApiVersion);
      const namespacedResources = resources.filter(r => r.namespaced && !r.name.includes("/"));
      for (const res of namespacedResources.slice(0, 10)) {
        const basePath = `/apis/${objApiVersion}`;
        const listPath = namespace
          ? `${basePath}/namespaces/${namespace}/${res.name}?limit=100`
          : `${basePath}/${res.name}?limit=100`;
        const result = await apiGetSafe(listPath);
        if (!result?.items) continue;

        for (const item of result.items) {
          if ((item.metadata?.ownerReferences || []).some((ref: any) => ref.uid === uid)) {
            children.push({
              kind: res.kind || item.kind || res.name,
              apiVersion: objApiVersion,
              name: item.metadata?.name,
              namespace: item.metadata?.namespace,
              relationship: "child (owned)",
              status: summarizeStatus(item),
            });
          }
        }
        if (children.length >= maxChildren) break;
      }
    } catch { /* CRD group search failed */ }
  }

  logger.debug(`Discovered ${children.length} children in ${Date.now() - start}ms`);
  return children;
}

// ── 3. Resolve label selectors ──

async function resolveSelectorTargets(object: any): Promise<RelatedResource[]> {
  const spec = object.spec || {};
  const namespace = object.metadata?.namespace;
  const kind = object.kind;
  const targets: RelatedResource[] = [];

  // Service / NetworkPolicy / DaemonSet / Deployment / etc. → selector → Pods
  const selector = spec.selector?.matchLabels || spec.selector;
  if (selector && typeof selector === "object" && !Array.isArray(selector) && namespace) {
    // Determine what the selector targets based on the resource kind
    const targetKind = getSelectsKind(kind);
    if (targetKind === "Pod") {
      const labelSelector = Object.entries(selector)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      const pods = await apiGetSafe(
        `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(labelSelector)}`
      );
      for (const pod of pods?.items || []) {
        targets.push({
          kind: "Pod",
          apiVersion: "v1",
          name: pod.metadata?.name,
          namespace: pod.metadata?.namespace,
          relationship: "selected by label selector",
          status: pod.status?.phase || "Unknown",
          detail: formatPodBrief(pod),
        });
      }
    }
  }

  // ServiceMonitor → selector → Services
  if (kind === "ServiceMonitor") {
    const svcSelector = spec.selector?.matchLabels;
    const nsSelector = spec.namespaceSelector;
    if (svcSelector && namespace) {
      const labelSelector = Object.entries(svcSelector)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      const svcNs = nsSelector?.any ? "" : namespace;
      const path = svcNs
        ? `/api/v1/namespaces/${svcNs}/services?labelSelector=${encodeURIComponent(labelSelector)}`
        : `/api/v1/services?labelSelector=${encodeURIComponent(labelSelector)}`;
      const svcs = await apiGetSafe(path);
      for (const svc of svcs?.items || []) {
        targets.push({
          kind: "Service",
          apiVersion: "v1",
          name: svc.metadata?.name,
          namespace: svc.metadata?.namespace,
          relationship: "monitored service",
          status: svc.spec?.type || "ClusterIP",
        });
      }
    }
  }

  return targets;
}

function getSelectsKind(kind: string): string {
  // Resources whose selector targets Pods
  const podSelectors = [
    "Service", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet",
    "Job", "NetworkPolicy", "PodDisruptionBudget",
  ];
  if (podSelectors.includes(kind)) return "Pod";
  return "Pod"; // default assumption for unknown kinds with selectors
}

// ── 4. Follow spec-level cross-references ──

async function resolveSpecReferences(object: any): Promise<RelatedResource[]> {
  const spec = object.spec || {};
  const namespace = object.metadata?.namespace;
  const kind = object.kind;
  const refs: RelatedResource[] = [];

  // Ingress → backend services → pods
  if (kind === "Ingress") {
    const services = new Set<string>();

    // Default backend
    if (spec.defaultBackend?.service?.name) {
      services.add(spec.defaultBackend.service.name);
    }

    // Rules
    for (const rule of spec.rules || []) {
      for (const path of rule.http?.paths || []) {
        if (path.backend?.service?.name) {
          services.add(path.backend.service.name);
        }
      }
    }

    // Resolve each service and its pods
    for (const svcName of services) {
      const svc = await apiGetSafe(`/api/v1/namespaces/${namespace}/services/${svcName}`);
      if (svc) {
        refs.push({
          kind: "Service",
          apiVersion: "v1",
          name: svcName,
          namespace,
          relationship: "backend service",
          status: svc.spec?.type || "ClusterIP",
          detail: `ports: ${(svc.spec?.ports || []).map((p: any) => p.port).join(",")}`,
        });

        // Service → Pods
        const svcSelector = svc.spec?.selector;
        if (svcSelector && namespace) {
          const labelSelector = Object.entries(svcSelector)
            .map(([k, v]) => `${k}=${v}`)
            .join(",");
          const pods = await apiGetSafe(
            `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(labelSelector)}`
          );
          for (const pod of (pods?.items || []).slice(0, 10)) {
            refs.push({
              kind: "Pod",
              apiVersion: "v1",
              name: pod.metadata?.name,
              namespace: pod.metadata?.namespace,
              relationship: `pod behind Service/${svcName}`,
              status: pod.status?.phase || "Unknown",
              detail: formatPodBrief(pod),
            });
          }
        }
      }
    }
  }

  // Generic: scan spec for common reference patterns
  const specRefs = findSpecReferences(spec, namespace);
  for (const ref of specRefs) {
    const resolved = await tryResolveReference(ref, namespace);
    if (resolved) refs.push(resolved);
  }

  return refs;
}

interface SpecRef {
  field: string;
  kind?: string;
  name: string;
  namespace?: string;
}

/**
 * Scan a spec object for common K8s reference patterns:
 * - secretName, configMapRef, secretRef, serviceAccountName
 * - secretStoreRef, clusterIssuerRef, issuerRef
 * - scaleTargetRef, volumeName
 */
function findSpecReferences(spec: any, namespace?: string, prefix = ""): SpecRef[] {
  const refs: SpecRef[] = [];
  if (!spec || typeof spec !== "object") return refs;
  if (Array.isArray(spec)) {
    for (let i = 0; i < Math.min(spec.length, 10); i++) {
      refs.push(...findSpecReferences(spec[i], namespace, `${prefix}[${i}]`));
    }
    return refs;
  }

  for (const [key, value] of Object.entries(spec)) {
    const path = prefix ? `${prefix}.${key}` : key;

    // Direct name references
    if (typeof value === "string" && value.length > 0 && value.length < 253) {
      if (key === "secretName" || key === "secretRef") {
        refs.push({ field: path, kind: "Secret", name: value, namespace });
      } else if (key === "configMapName" || key === "configMapRef") {
        refs.push({ field: path, kind: "ConfigMap", name: value, namespace });
      } else if (key === "serviceAccountName") {
        refs.push({ field: path, kind: "ServiceAccount", name: value, namespace });
      } else if (key === "serviceName" && !prefix.includes("tls")) {
        refs.push({ field: path, kind: "Service", name: value, namespace });
      } else if (key === "volumeName") {
        refs.push({ field: path, kind: "PersistentVolume", name: value });
      }
    }

    // Object references with name/kind
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const obj = value as any;

      // {name: "...", kind: "..."} pattern (secretStoreRef, issuerRef, scaleTargetRef)
      if (obj.name && typeof obj.name === "string") {
        if (key.endsWith("Ref") || key.endsWith("ref") || key === "scaleTargetRef") {
          refs.push({
            field: path,
            kind: obj.kind || key.replace(/Ref$/i, ""),
            name: obj.name,
            namespace: obj.namespace || namespace,
          });
          continue; // Don't recurse into this ref object
        }
      }

      // Recurse (limit depth)
      if (prefix.split(".").length < 4) {
        refs.push(...findSpecReferences(obj, namespace, path));
      }
    }
  }

  return refs;
}

async function tryResolveReference(ref: SpecRef, defaultNamespace?: string): Promise<RelatedResource | null> {
  const namespace = ref.namespace || defaultNamespace;
  const kind = ref.kind;
  const name = ref.name;
  if (!kind || !name) return null;

  // Try to find and verify the referenced resource exists
  // For core resources, we know the API path
  const coreKinds: Record<string, string> = {
    Secret: "/api/v1",
    ConfigMap: "/api/v1",
    Service: "/api/v1",
    ServiceAccount: "/api/v1",
    PersistentVolume: "/api/v1",
    PersistentVolumeClaim: "/api/v1",
  };

  const basePath = coreKinds[kind];
  if (basePath) {
    const path = namespace
      ? `${basePath}/namespaces/${namespace}/${kind.toLowerCase()}s/${name}`
      : `${basePath}/${kind.toLowerCase()}s/${name}`;
    const obj = await apiGetSafe(path);
    if (obj) {
      return {
        kind,
        apiVersion: "v1",
        name,
        namespace: obj.metadata?.namespace,
        relationship: `referenced by spec.${ref.field}`,
        status: summarizeStatus(obj),
      };
    }
  }

  // For CRDs, return a reference without verification
  return {
    kind,
    apiVersion: "unknown",
    name,
    namespace,
    relationship: `referenced by spec.${ref.field}`,
    status: "(not verified)",
  };
}

// ── API discovery helpers ──

interface APIResource {
  name: string;
  kind: string;
  namespaced: boolean;
}

async function discoverGroupResources(groupVersion: string): Promise<APIResource[]> {
  try {
    const basePath = groupVersion.includes("/") ? `/apis/${groupVersion}` : `/api/${groupVersion}`;
    const result = await apiGet(basePath);
    return (result?.resources || []).map((r: any) => ({
      name: r.name,
      kind: r.kind,
      namespaced: r.namespaced,
    }));
  } catch {
    return [];
  }
}

// ── Status summarizers ──

function summarizeStatus(obj: any): string {
  const status = obj.status || {};

  // Pod
  if (obj.kind === "Pod" || status.phase) {
    return status.phase || "Unknown";
  }

  // Conditions-based
  const conditions = status.conditions;
  if (Array.isArray(conditions) && conditions.length > 0) {
    const ready = conditions.find((c: any) => c.type === "Ready" || c.type === "Available");
    if (ready) return ready.status === "True" ? "Ready" : `NotReady (${ready.reason || ""})`;
    return conditions.map((c: any) => `${c.type}=${c.status}`).join(", ");
  }

  // Replica-based
  if (status.readyReplicas !== undefined) {
    const desired = obj.spec?.replicas ?? "?";
    return `${status.readyReplicas}/${desired} ready`;
  }

  return "—";
}

function formatPodBrief(pod: any): string {
  const cs = pod.status?.containerStatuses || [];
  const ready = cs.filter((c: any) => c.ready).length;
  const restarts = cs.reduce((sum: number, c: any) => sum + (c.restartCount || 0), 0);
  return `${ready}/${cs.length} containers ready, ${restarts} restarts`;
}

// ── API path builder ──

function buildResourcePath(apiVersion: string, kind: string, namespace?: string, name?: string): string | null {
  // Map kind to plural resource name (best guess)
  const plural = guessPluralName(kind);

  let basePath: string;
  if (!apiVersion.includes("/")) {
    // Core API: v1
    basePath = `/api/${apiVersion}`;
  } else {
    basePath = `/apis/${apiVersion}`;
  }

  if (namespace) {
    return name
      ? `${basePath}/namespaces/${namespace}/${plural}/${name}`
      : `${basePath}/namespaces/${namespace}/${plural}`;
  }
  return name
    ? `${basePath}/${plural}/${name}`
    : `${basePath}/${plural}`;
}

function guessPluralName(kind: string): string {
  // Common irregular plurals
  const irregulars: Record<string, string> = {
    Ingress: "ingresses",
    NetworkPolicy: "networkpolicies",
    Endpoints: "endpoints",
    EndpointSlice: "endpointslices",
  };
  if (irregulars[kind]) return irregulars[kind];

  const lower = kind.toLowerCase();
  // Kinds already ending in "s" (e.g. Chassis, Egress) — keep as-is
  if (lower.endsWith("s")) return lower;
  if (lower.endsWith("y")) return lower.slice(0, -1) + "ies";
  return lower + "s";
}

// ── Main entry point ──

export async function discoverRelationships(object: any): Promise<ResourceRelationships> {
  // Run all discovery in parallel
  const [owners, children, selectorTargets, specReferences] = await Promise.all([
    walkOwnersUp(object).catch(() => [] as RelatedResource[]),
    findChildren(object).catch(() => [] as RelatedResource[]),
    resolveSelectorTargets(object).catch(() => [] as RelatedResource[]),
    resolveSpecReferences(object).catch(() => [] as RelatedResource[]),
  ]);

  return { owners, children, selectorTargets, specReferences };
}

/**
 * Format discovered relationships as a context string for the AI prompt.
 */
export function formatRelationships(rels: ResourceRelationships): string {
  const lines: string[] = [];
  const total = rels.owners.length + rels.children.length + rels.selectorTargets.length + rels.specReferences.length;
  if (total === 0) return "";

  lines.push("\n═══ Related Resources (dynamically discovered) ═══");

  if (rels.owners.length > 0) {
    lines.push("\nOwner Chain (upstream):");
    for (const r of rels.owners) {
      lines.push(`  ↑ ${r.kind}/${r.name} [${r.relationship}] — ${r.status || "—"}`);
    }
  }

  if (rels.children.length > 0) {
    lines.push(`\nOwned Resources (${rels.children.length} downstream):`);
    for (const r of rels.children.slice(0, 30)) {
      lines.push(`  ↓ ${r.kind}/${r.name} — ${r.status || "—"}`);
    }
    if (rels.children.length > 30) {
      lines.push(`  ... and ${rels.children.length - 30} more`);
    }
  }

  if (rels.selectorTargets.length > 0) {
    lines.push(`\nSelector Targets (${rels.selectorTargets.length} matched):`);
    for (const r of rels.selectorTargets.slice(0, 20)) {
      lines.push(`  → ${r.kind}/${r.name} [${r.relationship}] — ${r.status || "—"}${r.detail ? ` (${r.detail})` : ""}`);
    }
    if (rels.selectorTargets.length > 20) {
      lines.push(`  ... and ${rels.selectorTargets.length - 20} more`);
    }
  }

  if (rels.specReferences.length > 0) {
    lines.push(`\nSpec References (${rels.specReferences.length}):`);
    for (const r of rels.specReferences.slice(0, 20)) {
      lines.push(`  ⟶ ${r.kind}/${r.name} [${r.relationship}] — ${r.status || "—"}`);
    }
  }

  return lines.join("\n");
}
