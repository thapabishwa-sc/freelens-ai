import { Renderer } from "@freelensapp/extensions";

type KubeObject = Renderer.K8sApi.KubeObject;

// Helper to safely access nested properties from the raw kube object
function get(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

function formatLabels(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return "  (none)";
  return Object.entries(labels).map(([k, v]) => `  ${k}: ${v}`).join("\n");
}

function formatConditions(conditions?: any[]): string {
  if (!conditions || conditions.length === 0) return "  (none)";
  return conditions.map((c: any) =>
    `  - ${c.type}: ${c.status}${c.reason ? ` (${c.reason})` : ""}${c.message ? ` — ${c.message}` : ""}`
  ).join("\n");
}

// ── K8s API helpers ──

async function fetchEvents(namespace: string, kind: string, name: string): Promise<any[]> {
  try {
    const api = Renderer.K8sApi.podsApi as any;
    const path = `/api/v1/namespaces/${namespace}/events?fieldSelector=involvedObject.name=${name},involvedObject.kind=${kind}`;
    const response = await api.request.get(path);
    return response?.items || [];
  } catch {
    return [];
  }
}

async function fetchResourceList(apiPath: string): Promise<any[]> {
  try {
    const api = Renderer.K8sApi.podsApi as any;
    const response = await api.request.get(apiPath);
    return response?.items || [];
  } catch {
    return [];
  }
}

/** Find pods matching a label selector in a namespace */
async function fetchPodsBySelector(namespace: string, selector: Record<string, string>): Promise<any[]> {
  if (!selector || Object.keys(selector).length === 0) return [];
  const labelSelector = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(",");
  return fetchResourceList(`/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(labelSelector)}`);
}

/** Find resources owned by a specific resource (via ownerReferences) */
async function fetchOwnedResources(apiPath: string, ownerUid: string): Promise<any[]> {
  const items = await fetchResourceList(apiPath);
  return items.filter((item: any) =>
    (item.metadata?.ownerReferences || []).some((ref: any) => ref.uid === ownerUid)
  );
}

/** Walk up the ownerReference chain to find the root owner */
function formatOwnerChain(object: any): string[] {
  const owners = object.metadata?.ownerReferences || [];
  if (owners.length === 0) return [];
  return owners.map((o: any) => `${o.kind}/${o.name}`);
}

function formatPodSummary(pods: any[]): string {
  if (pods.length === 0) return "  (no matching pods)";
  const lines: string[] = [];
  for (const pod of pods.slice(0, 20)) {
    const phase = pod.status?.phase || "Unknown";
    const ready = (pod.status?.containerStatuses || []).filter((c: any) => c.ready).length;
    const total = (pod.status?.containerStatuses || []).length;
    const restarts = (pod.status?.containerStatuses || []).reduce((sum: number, c: any) => sum + (c.restartCount || 0), 0);
    lines.push(`  - ${pod.metadata?.name}: ${phase} (${ready}/${total} ready, ${restarts} restarts)`);
  }
  if (pods.length > 20) lines.push(`  ... and ${pods.length - 20} more`);
  return lines.join("\n");
}

function formatReplicaSetSummary(replicaSets: any[]): string {
  if (replicaSets.length === 0) return "  (no matching ReplicaSets)";
  const lines: string[] = [];
  for (const rs of replicaSets) {
    const desired = rs.spec?.replicas ?? 0;
    const ready = rs.status?.readyReplicas ?? 0;
    lines.push(`  - ${rs.metadata?.name}: ${ready}/${desired} ready`);
  }
  return lines.join("\n");
}

// ── Pod ──

async function buildPodContext(object: KubeObject): Promise<string> {
  const spec = get(object, "spec") || {};
  const status = get(object, "status") || {};
  const meta = get(object, "metadata") || {};
  const lines: string[] = [];

  lines.push(`Phase: ${status.phase || "Unknown"}`);
  lines.push(`Node: ${spec.nodeName || "unassigned"}`);
  lines.push(`Service Account: ${spec.serviceAccountName || "default"}`);
  lines.push(`Restart Policy: ${spec.restartPolicy || "Always"}`);

  // Owner references (e.g., ReplicaSet → Deployment)
  const owners = formatOwnerChain(object);
  if (owners.length > 0) {
    lines.push(`\nOwned by: ${owners.join(", ")}`);
  }

  lines.push("\nConditions:");
  lines.push(formatConditions(status.conditions));

  // Init containers
  const initStatuses = status.initContainerStatuses || [];
  if (initStatuses.length > 0) {
    lines.push("\nInit Container Statuses:");
    for (const cs of initStatuses) {
      lines.push(`  - ${cs.name}: ready=${cs.ready}, restarts=${cs.restartCount}`);
      if (cs.state) {
        const stateKey = Object.keys(cs.state)[0];
        const stateVal = cs.state[stateKey];
        lines.push(`    state: ${stateKey}${stateVal?.reason ? ` (${stateVal.reason})` : ""}${stateVal?.message ? ` — ${stateVal.message}` : ""}`);
      }
    }
  }

  // Containers
  const containerStatuses = status.containerStatuses || [];
  lines.push("\nContainer Statuses:");
  for (const cs of containerStatuses) {
    lines.push(`  - ${cs.name}: ready=${cs.ready}, restarts=${cs.restartCount}`);
    if (cs.state) {
      const stateKey = Object.keys(cs.state)[0];
      const stateVal = cs.state[stateKey];
      lines.push(`    state: ${stateKey}${stateVal?.reason ? ` (${stateVal.reason})` : ""}${stateVal?.message ? ` — ${stateVal.message}` : ""}`);
    }
    if (cs.lastState && Object.keys(cs.lastState).length > 0) {
      const lastKey = Object.keys(cs.lastState)[0];
      const lastVal = cs.lastState[lastKey];
      lines.push(`    lastState: ${lastKey}${lastVal?.reason ? ` (${lastVal.reason})` : ""}${lastVal?.exitCode !== undefined ? ` exitCode=${lastVal.exitCode}` : ""}`);
    }
  }

  // Container specs with resources
  const containers = spec.containers || [];
  lines.push("\nContainer Specs:");
  for (const c of containers) {
    lines.push(`  - ${c.name}: image=${c.image}`);
    const req = c.resources?.requests;
    const lim = c.resources?.limits;
    if (req) lines.push(`    requests: cpu=${req.cpu || "—"}, memory=${req.memory || "—"}`);
    if (lim) lines.push(`    limits: cpu=${lim.cpu || "—"}, memory=${lim.memory || "—"}`);
  }

  // Volumes
  const volumes = spec.volumes || [];
  if (volumes.length > 0) {
    lines.push("\nVolumes:");
    for (const v of volumes) {
      const type = Object.keys(v).filter(k => k !== "name")[0] || "unknown";
      lines.push(`  - ${v.name} (${type})`);
    }
  }

  // Fetch recent logs
  try {
    const name = meta.name;
    const namespace = meta.namespace;
    if (name && namespace && status.phase === "Running") {
      const logs = await Renderer.K8sApi.podsApi.getLogs(
        { name, namespace },
        { tailLines: 80 }
      );
      if (logs) {
        lines.push("\nRecent Logs (last 80 lines):");
        lines.push(logs);
      }
    }
  } catch { /* logs unavailable */ }

  // Fetch events
  try {
    if (meta.name && meta.namespace) {
      const events = await fetchEvents(meta.namespace, "Pod", meta.name);
      if (events.length > 0) {
        lines.push("\nRecent Events:");
        for (const e of events.slice(-15)) {
          lines.push(`  - [${e.type}] ${e.reason}: ${e.message} (${e.count || 1}x)`);
        }
      }
    }
  } catch { /* events unavailable */ }

  return lines.join("\n");
}

// ── Node ──

async function buildNodeContext(object: KubeObject): Promise<string> {
  const spec = get(object, "spec") || {};
  const status = get(object, "status") || {};
  const meta = get(object, "metadata") || {};
  const lines: string[] = [];

  // Node info
  const info = status.nodeInfo || {};
  lines.push("Node Info:");
  lines.push(`  OS: ${info.osImage || "—"}`);
  lines.push(`  Kernel: ${info.kernelVersion || "—"}`);
  lines.push(`  Container Runtime: ${info.containerRuntimeVersion || "—"}`);
  lines.push(`  Kubelet: ${info.kubeletVersion || "—"}`);

  lines.push("\nConditions:");
  lines.push(formatConditions(status.conditions));

  // Capacity & Allocatable
  const cap = status.capacity || {};
  const alloc = status.allocatable || {};
  lines.push("\nCapacity:");
  lines.push(`  cpu: ${cap.cpu || "—"}, memory: ${cap.memory || "—"}, pods: ${cap.pods || "—"}`);
  lines.push(`  ephemeral-storage: ${cap["ephemeral-storage"] || "—"}`);
  lines.push("Allocatable:");
  lines.push(`  cpu: ${alloc.cpu || "—"}, memory: ${alloc.memory || "—"}, pods: ${alloc.pods || "—"}`);

  // Taints
  const taints = spec.taints || [];
  if (taints.length > 0) {
    lines.push("\nTaints:");
    for (const t of taints) {
      lines.push(`  - ${t.key}=${t.value || ""}:${t.effect}`);
    }
  } else {
    lines.push("\nTaints: (none)");
  }

  // Labels
  lines.push("\nLabels:");
  lines.push(formatLabels(meta.labels));

  // Pods running on this node
  try {
    const nodeName = meta.name;
    if (nodeName) {
      const pods = await fetchResourceList(`/api/v1/pods?fieldSelector=spec.nodeName=${nodeName}`);
      if (pods.length > 0) {
        lines.push(`\nPods on this node (${pods.length}):`);
        lines.push(formatPodSummary(pods));
      }
    }
  } catch { /* pods unavailable */ }

  return lines.join("\n");
}

// ── Deployment ──

async function buildDeploymentContext(object: KubeObject): Promise<string> {
  const spec = get(object, "spec") || {};
  const status = get(object, "status") || {};
  const meta = get(object, "metadata") || {};
  const lines: string[] = [];

  lines.push(`Replicas: desired=${spec.replicas ?? "—"}, ready=${status.readyReplicas ?? 0}, available=${status.availableReplicas ?? 0}, updated=${status.updatedReplicas ?? 0}`);
  lines.push(`Strategy: ${spec.strategy?.type || "RollingUpdate"}`);
  if (spec.strategy?.rollingUpdate) {
    const ru = spec.strategy.rollingUpdate;
    lines.push(`  maxUnavailable: ${ru.maxUnavailable ?? "25%"}, maxSurge: ${ru.maxSurge ?? "25%"}`);
  }

  lines.push("\nConditions:");
  lines.push(formatConditions(status.conditions));

  const selector = spec.selector?.matchLabels;
  if (selector) {
    lines.push("\nSelector:");
    lines.push(formatLabels(selector));
  }

  // Pod template containers
  const containers = spec.template?.spec?.containers || [];
  if (containers.length > 0) {
    lines.push("\nPod Template Containers:");
    for (const c of containers) {
      lines.push(`  - ${c.name}: image=${c.image}`);
      const req = c.resources?.requests;
      const lim = c.resources?.limits;
      if (req) lines.push(`    requests: cpu=${req.cpu || "—"}, memory=${req.memory || "—"}`);
      if (lim) lines.push(`    limits: cpu=${lim.cpu || "—"}, memory=${lim.memory || "—"}`);
    }
  }

  // Downstream: Deployment → ReplicaSets → Pods
  try {
    const namespace = meta.namespace;
    const uid = meta.uid;
    if (namespace && uid) {
      const allRS = await fetchResourceList(`/apis/apps/v1/namespaces/${namespace}/replicasets`);
      const ownedRS = allRS.filter((rs: any) =>
        (rs.metadata?.ownerReferences || []).some((ref: any) => ref.uid === uid)
      );

      if (ownedRS.length > 0) {
        lines.push(`\nOwned ReplicaSets (${ownedRS.length}):`);
        lines.push(formatReplicaSetSummary(ownedRS));

        // Get pods from the active RS (highest revision or non-zero replicas)
        const activeRS = ownedRS.filter((rs: any) => (rs.spec?.replicas ?? 0) > 0);
        for (const rs of activeRS) {
          const rsSelector = rs.spec?.selector?.matchLabels;
          if (rsSelector) {
            const pods = await fetchPodsBySelector(namespace, rsSelector);
            if (pods.length > 0) {
              lines.push(`\nPods (via ${rs.metadata?.name}):`);
              lines.push(formatPodSummary(pods));
            }
          }
        }
      }
    }
  } catch { /* relationship unavailable */ }

  return lines.join("\n");
}

// ── StatefulSet ──

async function buildStatefulSetContext(object: KubeObject): Promise<string> {
  const spec = get(object, "spec") || {};
  const status = get(object, "status") || {};
  const meta = get(object, "metadata") || {};
  const lines: string[] = [];

  lines.push(`Replicas: desired=${spec.replicas ?? "—"}, ready=${status.readyReplicas ?? 0}, current=${status.currentReplicas ?? 0}, updated=${status.updatedReplicas ?? 0}`);
  lines.push(`Update Strategy: ${spec.updateStrategy?.type || "RollingUpdate"}`);
  lines.push(`Pod Management Policy: ${spec.podManagementPolicy || "OrderedReady"}`);
  lines.push(`Service Name: ${spec.serviceName || "—"}`);

  lines.push("\nConditions:");
  lines.push(formatConditions(status.conditions));

  // Volume claim templates
  const vcts = spec.volumeClaimTemplates || [];
  if (vcts.length > 0) {
    lines.push("\nVolume Claim Templates:");
    for (const v of vcts) {
      const storage = v.spec?.resources?.requests?.storage || "—";
      const sc = v.spec?.storageClassName || "default";
      lines.push(`  - ${v.metadata?.name}: ${storage} (storageClass: ${sc})`);
    }
  }

  // Pod template
  const containers = spec.template?.spec?.containers || [];
  if (containers.length > 0) {
    lines.push("\nPod Template Containers:");
    for (const c of containers) {
      lines.push(`  - ${c.name}: image=${c.image}`);
    }
  }

  // Downstream: StatefulSet → Pods
  try {
    const selector = spec.selector?.matchLabels;
    if (meta.namespace && selector) {
      const pods = await fetchPodsBySelector(meta.namespace, selector);
      if (pods.length > 0) {
        lines.push(`\nManaged Pods (${pods.length}):`);
        lines.push(formatPodSummary(pods));
      }
    }
  } catch { /* pods unavailable */ }

  return lines.join("\n");
}

// ── DaemonSet ──

async function buildDaemonSetContext(object: KubeObject): Promise<string> {
  const spec = get(object, "spec") || {};
  const status = get(object, "status") || {};
  const meta = get(object, "metadata") || {};
  const lines: string[] = [];

  lines.push(`Desired: ${status.desiredNumberScheduled ?? "—"}, Current: ${status.currentNumberScheduled ?? 0}, Ready: ${status.numberReady ?? 0}, Available: ${status.numberAvailable ?? 0}`);
  lines.push(`Misscheduled: ${status.numberMisscheduled ?? 0}`);
  lines.push(`Update Strategy: ${spec.updateStrategy?.type || "RollingUpdate"}`);

  const selector = spec.selector?.matchLabels;
  if (selector) {
    lines.push("\nSelector:");
    lines.push(formatLabels(selector));
  }

  const containers = spec.template?.spec?.containers || [];
  if (containers.length > 0) {
    lines.push("\nPod Template Containers:");
    for (const c of containers) {
      lines.push(`  - ${c.name}: image=${c.image}`);
    }
  }

  // Downstream: DaemonSet → Pods
  try {
    if (meta.namespace && selector) {
      const pods = await fetchPodsBySelector(meta.namespace, selector);
      if (pods.length > 0) {
        lines.push(`\nManaged Pods (${pods.length}):`);
        lines.push(formatPodSummary(pods));
      }
    }
  } catch { /* pods unavailable */ }

  return lines.join("\n");
}

// ── ReplicaSet ──

async function buildReplicaSetContext(object: KubeObject): Promise<string> {
  const spec = get(object, "spec") || {};
  const status = get(object, "status") || {};
  const meta = get(object, "metadata") || {};
  const lines: string[] = [];

  lines.push(`Replicas: desired=${spec.replicas ?? "—"}, ready=${status.readyReplicas ?? 0}, available=${status.availableReplicas ?? 0}`);

  const owners = formatOwnerChain(object);
  if (owners.length > 0) {
    lines.push(`\nOwned by: ${owners.join(", ")}`);
  }

  lines.push("\nConditions:");
  lines.push(formatConditions(status.conditions));

  // Downstream: ReplicaSet → Pods
  try {
    const selector = spec.selector?.matchLabels;
    if (meta.namespace && selector) {
      const pods = await fetchPodsBySelector(meta.namespace, selector);
      if (pods.length > 0) {
        lines.push(`\nManaged Pods (${pods.length}):`);
        lines.push(formatPodSummary(pods));
      }
    }
  } catch { /* pods unavailable */ }

  return lines.join("\n");
}

// ── Job ──

async function buildJobContext(object: KubeObject): Promise<string> {
  const spec = get(object, "spec") || {};
  const status = get(object, "status") || {};
  const meta = get(object, "metadata") || {};
  const lines: string[] = [];

  lines.push(`Completions: ${spec.completions ?? 1}, Parallelism: ${spec.parallelism ?? 1}`);
  lines.push(`Backoff Limit: ${spec.backoffLimit ?? 6}`);
  lines.push(`Active: ${status.active ?? 0}, Succeeded: ${status.succeeded ?? 0}, Failed: ${status.failed ?? 0}`);
  if (status.startTime) lines.push(`Start Time: ${status.startTime}`);
  if (status.completionTime) lines.push(`Completion Time: ${status.completionTime}`);

  const owners = formatOwnerChain(object);
  if (owners.length > 0) {
    lines.push(`\nOwned by: ${owners.join(", ")}`);
  }

  lines.push("\nConditions:");
  lines.push(formatConditions(status.conditions));

  const containers = spec.template?.spec?.containers || [];
  if (containers.length > 0) {
    lines.push("\nContainers:");
    for (const c of containers) {
      lines.push(`  - ${c.name}: image=${c.image}`);
    }
  }

  // Downstream: Job → Pods
  try {
    const uid = meta.uid;
    if (meta.namespace && uid) {
      const pods = await fetchResourceList(`/api/v1/namespaces/${meta.namespace}/pods`);
      const jobPods = pods.filter((p: any) =>
        (p.metadata?.ownerReferences || []).some((ref: any) => ref.uid === uid)
      );
      if (jobPods.length > 0) {
        lines.push(`\nJob Pods (${jobPods.length}):`);
        lines.push(formatPodSummary(jobPods));
      }
    }
  } catch { /* pods unavailable */ }

  return lines.join("\n");
}

// ── CronJob ──

async function buildCronJobContext(object: KubeObject): Promise<string> {
  const spec = get(object, "spec") || {};
  const status = get(object, "status") || {};
  const meta = get(object, "metadata") || {};
  const lines: string[] = [];

  lines.push(`Schedule: ${spec.schedule || "—"}`);
  lines.push(`Suspend: ${spec.suspend ?? false}`);
  lines.push(`Concurrency Policy: ${spec.concurrencyPolicy || "Allow"}`);
  lines.push(`Successful Jobs History Limit: ${spec.successfulJobsHistoryLimit ?? 3}`);
  lines.push(`Failed Jobs History Limit: ${spec.failedJobsHistoryLimit ?? 1}`);
  if (status.lastScheduleTime) lines.push(`Last Scheduled: ${status.lastScheduleTime}`);
  if (status.lastSuccessfulTime) lines.push(`Last Successful: ${status.lastSuccessfulTime}`);

  const active = status.active || [];
  if (active.length > 0) {
    lines.push(`\nActive Jobs: ${active.length}`);
    for (const a of active) {
      lines.push(`  - ${a.namespace}/${a.name}`);
    }
  } else {
    lines.push("\nActive Jobs: 0");
  }

  // Downstream: CronJob → Jobs
  try {
    const uid = meta.uid;
    if (meta.namespace && uid) {
      const jobs = await fetchOwnedResources(`/apis/batch/v1/namespaces/${meta.namespace}/jobs`, uid);
      if (jobs.length > 0) {
        lines.push(`\nChild Jobs (${jobs.length}):`);
        for (const j of jobs.slice(-5)) {
          const jStatus = j.status || {};
          const conds = (jStatus.conditions || []).map((c: any) => c.type).join(",") || "Running";
          lines.push(`  - ${j.metadata?.name}: active=${jStatus.active ?? 0} succeeded=${jStatus.succeeded ?? 0} failed=${jStatus.failed ?? 0} (${conds})`);
        }
        if (jobs.length > 5) lines.push(`  ... and ${jobs.length - 5} older jobs`);
      }
    }
  } catch { /* jobs unavailable */ }

  return lines.join("\n");
}

// ── Service ──

async function buildServiceContext(object: KubeObject): Promise<string> {
  const spec = get(object, "spec") || {};
  const status = get(object, "status") || {};
  const meta = get(object, "metadata") || {};
  const lines: string[] = [];

  lines.push(`Type: ${spec.type || "ClusterIP"}`);
  lines.push(`Cluster IP: ${spec.clusterIP || "—"}`);
  if (spec.externalIPs?.length) lines.push(`External IPs: ${spec.externalIPs.join(", ")}`);
  if (spec.loadBalancerIP) lines.push(`Load Balancer IP: ${spec.loadBalancerIP}`);

  const lbIngress = status.loadBalancer?.ingress;
  if (lbIngress?.length) {
    lines.push("Load Balancer Ingress:");
    for (const i of lbIngress) {
      lines.push(`  - ${i.hostname || i.ip || "—"}`);
    }
  }

  lines.push(`Session Affinity: ${spec.sessionAffinity || "None"}`);

  // Ports
  const ports = spec.ports || [];
  if (ports.length > 0) {
    lines.push("\nPorts:");
    for (const p of ports) {
      lines.push(`  - ${p.name || "unnamed"}: ${p.port}${p.targetPort ? `→${p.targetPort}` : ""} (${p.protocol || "TCP"})${p.nodePort ? ` nodePort=${p.nodePort}` : ""}`);
    }
  }

  // Selector
  const selector = spec.selector;
  if (selector) {
    lines.push("\nSelector:");
    lines.push(formatLabels(selector));

    // Downstream: Service → matching Pods
    try {
      if (meta.namespace) {
        const pods = await fetchPodsBySelector(meta.namespace, selector);
        if (pods.length > 0) {
          lines.push(`\nTarget Pods (${pods.length}):`);
          lines.push(formatPodSummary(pods));
        } else {
          lines.push("\nTarget Pods: (no pods match selector — this may indicate a problem)");
        }
      }
    } catch { /* pods unavailable */ }
  }

  // Fetch endpoints
  try {
    if (meta.name && meta.namespace) {
      const endpoints = await fetchResourceList(`/api/v1/namespaces/${meta.namespace}/endpoints/${meta.name}`);
      // endpoints is a single object when fetched by name, handle both cases
      const subsets = (Array.isArray(endpoints) ? endpoints[0] : endpoints)?.subsets || [];
      if (subsets.length > 0) {
        lines.push("\nEndpoints:");
        for (const s of subsets) {
          const addrs = (s.addresses || []).map((a: any) => a.ip).join(", ") || "(none)";
          const notReady = (s.notReadyAddresses || []).map((a: any) => a.ip).join(", ");
          const epPorts = (s.ports || []).map((p: any) => `${p.port}/${p.protocol || "TCP"}`).join(", ");
          lines.push(`  Ready: ${addrs} | Ports: ${epPorts}`);
          if (notReady) lines.push(`  Not Ready: ${notReady}`);
        }
      }
    }
  } catch { /* endpoints unavailable */ }

  return lines.join("\n");
}

// ── Ingress ──

function buildIngressContext(object: KubeObject): string {
  const spec = get(object, "spec") || {};
  const status = get(object, "status") || {};
  const lines: string[] = [];

  if (spec.ingressClassName) lines.push(`Ingress Class: ${spec.ingressClassName}`);

  const tls = spec.tls || [];
  if (tls.length > 0) {
    lines.push("\nTLS:");
    for (const t of tls) {
      lines.push(`  - hosts: ${(t.hosts || []).join(", ")} secret: ${t.secretName || "—"}`);
    }
  }

  const rules = spec.rules || [];
  if (rules.length > 0) {
    lines.push("\nRules:");
    for (const r of rules) {
      lines.push(`  Host: ${r.host || "*"}`);
      const paths = r.http?.paths || [];
      for (const p of paths) {
        const backend = p.backend?.service
          ? `${p.backend.service.name}:${p.backend.service.port?.number || p.backend.service.port?.name || "—"}`
          : "—";
        lines.push(`    ${p.pathType || "Prefix"} ${p.path || "/"} → ${backend}`);
      }
    }
  }

  if (spec.defaultBackend?.service) {
    const svc = spec.defaultBackend.service;
    lines.push(`\nDefault Backend: ${svc.name}:${svc.port?.number || svc.port?.name || "—"}`);
  }

  const lbIngress = status.loadBalancer?.ingress;
  if (lbIngress?.length) {
    lines.push("\nLoad Balancer:");
    for (const i of lbIngress) {
      lines.push(`  - ${i.hostname || i.ip || "—"}`);
    }
  }

  return lines.join("\n");
}

// ── ConfigMap ──

function buildConfigMapContext(object: KubeObject): string {
  const data = get(object, "data") || {};
  const binaryData = get(object, "binaryData") || {};
  const lines: string[] = [];

  const dataKeys = Object.keys(data);
  const binaryKeys = Object.keys(binaryData);

  lines.push(`Data Keys (${dataKeys.length}):`);
  for (const k of dataKeys) {
    const val = data[k];
    const size = typeof val === "string" ? val.length : 0;
    lines.push(`  - ${k} (${size} chars)`);
  }

  if (binaryKeys.length > 0) {
    lines.push(`\nBinary Data Keys (${binaryKeys.length}):`);
    for (const k of binaryKeys) {
      lines.push(`  - ${k}`);
    }
  }

  lines.push("\n(Values omitted for security — only key names shown)");

  return lines.join("\n");
}

// ── Secret ──

function buildSecretContext(object: KubeObject): string {
  const type = get(object, "type") || "Opaque";
  const data = get(object, "data") || {};
  const lines: string[] = [];

  lines.push(`Type: ${type}`);

  const keys = Object.keys(data);
  lines.push(`\nData Keys (${keys.length}):`);
  for (const k of keys) {
    lines.push(`  - ${k}`);
  }

  lines.push("\n(Values are NEVER shown — only key names listed for structural analysis)");

  return lines.join("\n");
}

// ── PersistentVolumeClaim ──

function buildPVCContext(object: KubeObject): string {
  const spec = get(object, "spec") || {};
  const status = get(object, "status") || {};
  const lines: string[] = [];

  lines.push(`Phase: ${status.phase || "—"}`);
  lines.push(`Storage Class: ${spec.storageClassName || "default"}`);
  lines.push(`Access Modes: ${(spec.accessModes || []).join(", ") || "—"}`);
  lines.push(`Volume Name: ${spec.volumeName || "—"}`);
  lines.push(`Volume Mode: ${spec.volumeMode || "Filesystem"}`);

  const requested = spec.resources?.requests?.storage;
  const actual = status.capacity?.storage;
  lines.push(`\nRequested: ${requested || "—"}`);
  lines.push(`Actual Capacity: ${actual || "—"}`);

  lines.push("\nConditions:");
  lines.push(formatConditions(status.conditions));

  return lines.join("\n");
}

// ── NetworkPolicy ──

function buildNetworkPolicyContext(object: KubeObject): string {
  const spec = get(object, "spec") || {};
  const lines: string[] = [];

  lines.push(`Policy Types: ${(spec.policyTypes || []).join(", ") || "—"}`);

  const selector = spec.podSelector?.matchLabels;
  lines.push("\nPod Selector:");
  if (selector && Object.keys(selector).length > 0) {
    lines.push(formatLabels(selector));
  } else {
    lines.push("  (selects all pods in namespace)");
  }

  const ingress = spec.ingress || [];
  if (ingress.length > 0) {
    lines.push("\nIngress Rules:");
    for (let i = 0; i < ingress.length; i++) {
      const rule = ingress[i];
      lines.push(`  Rule ${i + 1}:`);
      for (const from of rule.from || []) {
        if (from.podSelector) lines.push(`    from pods: ${JSON.stringify(from.podSelector.matchLabels || {})}`);
        if (from.namespaceSelector) lines.push(`    from namespaces: ${JSON.stringify(from.namespaceSelector.matchLabels || {})}`);
        if (from.ipBlock) lines.push(`    from CIDR: ${from.ipBlock.cidr}${from.ipBlock.except ? ` except ${from.ipBlock.except.join(",")}` : ""}`);
      }
      for (const port of rule.ports || []) {
        lines.push(`    port: ${port.port || "all"} (${port.protocol || "TCP"})`);
      }
    }
  }

  const egress = spec.egress || [];
  if (egress.length > 0) {
    lines.push("\nEgress Rules:");
    for (let i = 0; i < egress.length; i++) {
      const rule = egress[i];
      lines.push(`  Rule ${i + 1}:`);
      for (const to of rule.to || []) {
        if (to.podSelector) lines.push(`    to pods: ${JSON.stringify(to.podSelector.matchLabels || {})}`);
        if (to.namespaceSelector) lines.push(`    to namespaces: ${JSON.stringify(to.namespaceSelector.matchLabels || {})}`);
        if (to.ipBlock) lines.push(`    to CIDR: ${to.ipBlock.cidr}${to.ipBlock.except ? ` except ${to.ipBlock.except.join(",")}` : ""}`);
      }
      for (const port of rule.ports || []) {
        lines.push(`    port: ${port.port || "all"} (${port.protocol || "TCP"})`);
      }
    }
  }

  return lines.join("\n");
}

// ── Namespace ──

function buildNamespaceContext(object: KubeObject): string {
  const status = get(object, "status") || {};
  const labels = get(object, "metadata.labels") || {};
  const annotations = get(object, "metadata.annotations") || {};
  const lines: string[] = [];

  lines.push(`Phase: ${status.phase || "—"}`);

  lines.push("\nLabels:");
  lines.push(formatLabels(labels));

  const filteredAnnotations = Object.fromEntries(
    Object.entries(annotations).filter(([k]) => !k.startsWith("kubectl.kubernetes.io/"))
  );
  if (Object.keys(filteredAnnotations).length > 0) {
    lines.push("\nAnnotations:");
    lines.push(formatLabels(filteredAnnotations as Record<string, string>));
  }

  return lines.join("\n");
}

// ── Generic / CRD fallback ──
// Works for any resource kind including CRDs. Extracts:
// - ownerReferences (upstream relationship)
// - owned resources (downstream relationship via ownerRef matching)
// - spec + status (JSON dump, truncated)
// - conditions (if present in status)
// - events

async function buildGenericContext(object: KubeObject): Promise<string> {
  const spec = get(object, "spec");
  const status = get(object, "status");
  const meta = get(object, "metadata") || {};
  const kind = get(object, "kind") || "Unknown";
  const apiVersion = get(object, "apiVersion") || "";
  const lines: string[] = [];

  lines.push(`API Version: ${apiVersion}`);
  lines.push(`Kind: ${kind}`);

  // Owner references (upstream)
  const owners = formatOwnerChain(object);
  if (owners.length > 0) {
    lines.push(`\nOwned by: ${owners.join(", ")}`);
  }

  // Labels
  if (meta.labels && Object.keys(meta.labels).length > 0) {
    lines.push("\nLabels:");
    lines.push(formatLabels(meta.labels as Record<string, string>));
  }

  // Conditions
  const conditions = status?.conditions;
  if (conditions && Array.isArray(conditions) && conditions.length > 0) {
    lines.push("\nConditions:");
    lines.push(formatConditions(conditions));
  }

  // Spec (truncated for large CRDs)
  if (spec) {
    const specJson = JSON.stringify(spec, null, 2);
    if (specJson.length <= 3000) {
      lines.push("\nSpec:");
      lines.push(specJson.split("\n").map(l => `  ${l}`).join("\n"));
    } else {
      // Show top-level keys and truncated content
      lines.push("\nSpec (truncated — large resource):");
      lines.push(`  Top-level keys: ${Object.keys(spec).join(", ")}`);
      lines.push(specJson.slice(0, 3000).split("\n").map(l => `  ${l}`).join("\n"));
      lines.push("  ...");
    }
  }

  // Status (truncated)
  if (status) {
    const statusJson = JSON.stringify(status, null, 2);
    if (statusJson.length <= 2000) {
      lines.push("\nStatus:");
      lines.push(statusJson.split("\n").map(l => `  ${l}`).join("\n"));
    } else {
      lines.push("\nStatus (truncated):");
      lines.push(`  Top-level keys: ${Object.keys(status).join(", ")}`);
      lines.push(statusJson.slice(0, 2000).split("\n").map(l => `  ${l}`).join("\n"));
      lines.push("  ...");
    }
  }

  // Note: downstream/owned resource discovery is handled by relationship-discovery.ts
  // and included automatically in the analysis prompt.

  // Events
  try {
    if (meta.name && meta.namespace) {
      const events = await fetchEvents(meta.namespace, kind, meta.name);
      if (events.length > 0) {
        lines.push("\nRecent Events:");
        for (const e of events.slice(-15)) {
          lines.push(`  - [${e.type}] ${e.reason}: ${e.message} (${e.count || 1}x)`);
        }
      }
    }
  } catch { /* events unavailable */ }

  return lines.join("\n") || "(no spec or status)";
}

// ── Main entry point ──

const BUILDERS: Record<string, (object: KubeObject) => string | Promise<string>> = {
  Pod: buildPodContext,
  Node: buildNodeContext,
  Deployment: buildDeploymentContext,
  StatefulSet: buildStatefulSetContext,
  DaemonSet: buildDaemonSetContext,
  ReplicaSet: buildReplicaSetContext,
  Job: buildJobContext,
  CronJob: buildCronJobContext,
  Service: buildServiceContext,
  Ingress: buildIngressContext,
  ConfigMap: buildConfigMapContext,
  Secret: buildSecretContext,
  PersistentVolumeClaim: buildPVCContext,
  NetworkPolicy: buildNetworkPolicyContext,
  Namespace: buildNamespaceContext,
};

export async function buildResourceContext(kind: string, object: KubeObject): Promise<string> {
  const builder = BUILDERS[kind];
  if (builder) {
    return await builder(object);
  }
  // Generic/CRD fallback — handles any resource kind
  return buildGenericContext(object);
}
