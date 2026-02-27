export interface ContainerInfo {
  name: string;
  status: "running" | "waiting" | "terminated";
  isInit: boolean;
}

export interface OwnerRef {
  kind: string;
  name: string;
}

/** Extract container info from a raw pod object */
export function extractContainers(pod: any): ContainerInfo[] {
  const spec = pod.spec || {};
  const status = pod.status || {};
  const result: ContainerInfo[] = [];

  // Init containers
  const initSpecs: any[] = spec.initContainers || [];
  const initStatuses: any[] = status.initContainerStatuses || [];
  for (const cs of initSpecs) {
    const st = initStatuses.find((s: any) => s.name === cs.name);
    result.push({
      name: cs.name,
      status: getContainerState(st),
      isInit: true,
    });
  }

  // Regular containers
  const containerSpecs: any[] = spec.containers || [];
  const containerStatuses: any[] = status.containerStatuses || [];
  for (const cs of containerSpecs) {
    const st = containerStatuses.find((s: any) => s.name === cs.name);
    result.push({
      name: cs.name,
      status: getContainerState(st),
      isInit: false,
    });
  }

  return result;
}

/** Extract ownerRef from a raw pod object */
export function extractOwnerRef(pod: any): OwnerRef | undefined {
  const refs: any[] = pod?.metadata?.ownerReferences || [];
  const primary = refs.find((r: any) => r.controller) || refs[0];
  if (!primary) return undefined;
  return { kind: primary.kind, name: primary.name };
}

function getContainerState(st: any): "running" | "waiting" | "terminated" {
  if (!st?.state) return "waiting";
  if (st.state.running) return "running";
  if (st.state.terminated) return "terminated";
  return "waiting";
}
