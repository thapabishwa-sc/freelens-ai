import { memo, useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";
import type { ResourceRelationships, RelatedResource } from "../services/relationship-discovery";

// ── Types ──

interface GraphNodeData {
  kind: string;
  name: string;
  namespace?: string;
  status?: string;
  isCurrent?: boolean;
  healthHint?: "healthy" | "warning" | "critical";
}

interface RelationshipGraphProps {
  relationships: ResourceRelationships;
  currentKind: string;
  currentName: string;
  currentNamespace?: string;
}

// ── Custom Node ──

const GraphNode = memo(({ data }: NodeProps<GraphNodeData>) => {
  const statusClass = data.isCurrent
    ? "flai-graph-node--current"
    : data.healthHint
      ? `flai-graph-node--${data.healthHint}`
      : "";

  return (
    <div className={`flai-graph-node ${statusClass}`}>
      <Handle type="target" position={Position.Top} style={{ visibility: "hidden" }} />
      <div className="flai-graph-node__header">
        <span className="flai-graph-node__kind">{data.kind}</span>
      </div>
      <div className="flai-graph-node__name" title={data.name}>{data.name}</div>
      {data.status && <div className="flai-graph-node__status">{data.status}</div>}
      <Handle type="source" position={Position.Bottom} style={{ visibility: "hidden" }} />
    </div>
  );
});

GraphNode.displayName = "GraphNode";

const nodeTypes = { custom: GraphNode };

// ── Health hint from status text ──

function inferHealth(status?: string): "healthy" | "warning" | "critical" | undefined {
  if (!status) return undefined;
  const s = status.toLowerCase();
  if (s.includes("running") || s.includes("ready") || s.includes("active") || s.includes("bound")) return "healthy";
  if (s.includes("pending") || s.includes("waiting") || s.includes("not ready")) return "warning";
  if (s.includes("failed") || s.includes("error") || s.includes("crash") || s.includes("evicted")) return "critical";
  return undefined;
}

// ── Build nodes & edges ──

function buildGraph(
  relationships: ResourceRelationships,
  currentKind: string,
  currentName: string,
  currentNamespace?: string,
): { nodes: Node<GraphNodeData>[]; edges: Edge[] } {
  const nodes: Node<GraphNodeData>[] = [];
  const edges: Edge[] = [];
  const nodeIdSet = new Set<string>();

  const makeId = (kind: string, name: string, ns?: string) =>
    ns ? `${kind}/${ns}/${name}` : `${kind}/${name}`;

  const addNode = (
    id: string,
    data: GraphNodeData,
    tier: number,
    indexInTier: number,
    tierSize: number,
  ) => {
    if (nodeIdSet.has(id)) return;
    nodeIdSet.add(id);

    const tierSpacing = 120;
    const nodeWidth = 180;
    const gap = 30;
    const totalWidth = tierSize * nodeWidth + (tierSize - 1) * gap;
    const startX = -totalWidth / 2 + nodeWidth / 2;
    const x = startX + indexInTier * (nodeWidth + gap);
    const y = tier * tierSpacing;

    nodes.push({
      id,
      type: "custom",
      data,
      position: { x, y },
    });
  };

  const addEdge = (sourceId: string, targetId: string, label?: string) => {
    const edgeId = `${sourceId}->${targetId}`;
    if (edges.some((e) => e.id === edgeId)) return;
    edges.push({
      id: edgeId,
      source: sourceId,
      target: targetId,
      label,
      labelStyle: { fontSize: 9 },
      labelBgStyle: { fill: "var(--mainBackground, #fafafa)", fillOpacity: 0.9 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
      style: { stroke: "var(--textColorSecondary, #888)", strokeWidth: 1.5 },
    });
  };

  // Tier assignment:
  // 0: top-level owners (furthest ancestor)
  // 1: direct owners
  // 2: current resource
  // 3: children + selector targets
  // 4: spec references

  // Owners (reversed so highest ancestor is at top)
  const owners = [...relationships.owners].reverse();
  const ownerTierStart = Math.max(0, 2 - owners.length);
  owners.forEach((r, i) => {
    const id = makeId(r.kind, r.name, r.namespace);
    addNode(id, {
      kind: r.kind,
      name: r.name,
      namespace: r.namespace,
      status: r.status || r.detail,
      healthHint: inferHealth(r.status),
    }, ownerTierStart + i, 0, 1);
  });

  // Current resource (tier 2)
  const currentId = makeId(currentKind, currentName, currentNamespace);
  addNode(currentId, {
    kind: currentKind,
    name: currentName,
    namespace: currentNamespace,
    isCurrent: true,
  }, 2, 0, 1);

  // Edges from owners to current
  if (owners.length > 0) {
    // Chain owners: top → ... → direct owner → current
    for (let i = 0; i < owners.length - 1; i++) {
      const fromId = makeId(owners[i].kind, owners[i].name, owners[i].namespace);
      const toId = makeId(owners[i + 1].kind, owners[i + 1].name, owners[i + 1].namespace);
      addEdge(fromId, toId, "owns");
    }
    const directOwner = owners[owners.length - 1];
    addEdge(makeId(directOwner.kind, directOwner.name, directOwner.namespace), currentId, "owns");
  }

  // Children + selector targets (tier 3)
  // Deduplicate: if a resource appears in both children and selectorTargets, prefer children
  const childMap = new Map<string, RelatedResource>();
  for (const r of relationships.children) {
    childMap.set(makeId(r.kind, r.name, r.namespace), r);
  }
  for (const r of relationships.selectorTargets) {
    const id = makeId(r.kind, r.name, r.namespace);
    if (!childMap.has(id)) childMap.set(id, r);
  }

  const childResources = [...childMap.entries()];
  // Limit to 8 to keep graph readable
  const visibleChildren = childResources.slice(0, 8);
  visibleChildren.forEach(([id, r], i) => {
    addNode(id, {
      kind: r.kind,
      name: r.name,
      namespace: r.namespace,
      status: r.status || r.detail,
      healthHint: inferHealth(r.status),
    }, 3, i, visibleChildren.length);

    const isSelector = relationships.selectorTargets.some(
      (s) => makeId(s.kind, s.name, s.namespace) === id
    );
    addEdge(currentId, id, isSelector ? "selects" : "owns");
  });

  // Spec references (tier 4) — only ones not already shown
  const specRefs = relationships.specReferences.filter(
    (r) => !nodeIdSet.has(makeId(r.kind, r.name, r.namespace))
  );
  const visibleRefs = specRefs.slice(0, 6);
  visibleRefs.forEach((r, i) => {
    const id = makeId(r.kind, r.name, r.namespace);
    addNode(id, {
      kind: r.kind,
      name: r.name,
      namespace: r.namespace,
      status: r.status || r.detail,
      healthHint: inferHealth(r.status),
    }, 4, i, visibleRefs.length);
    addEdge(currentId, id, "refs");
  });

  // Add overflow indicators
  if (childResources.length > 8) {
    const overflowId = "__overflow-children";
    addNode(overflowId, {
      kind: "",
      name: `+${childResources.length - 8} more`,
    }, 3, visibleChildren.length, visibleChildren.length + 1);
  }

  return { nodes, edges };
}

// ── Main Component ──

export function RelationshipGraph({
  relationships,
  currentKind,
  currentName,
  currentNamespace,
}: RelationshipGraphProps) {
  const { nodes, edges } = useMemo(
    () => buildGraph(relationships, currentKind, currentName, currentNamespace),
    [relationships, currentKind, currentName, currentNamespace],
  );

  const hasData = relationships.owners.length > 0
    || relationships.children.length > 0
    || relationships.selectorTargets.length > 0
    || relationships.specReferences.length > 0;

  if (!hasData) {
    return (
      <div className="flai-results__section">
        <h3 className="flai-results__heading">Relationships</h3>
        <div style={{ fontSize: 12, opacity: 0.5 }}>No related resources discovered.</div>
      </div>
    );
  }

  return (
    <div className="flai-results__section">
      <h3 className="flai-results__heading">Relationships</h3>
      <div className="flai-graph">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          minZoom={0.3}
          maxZoom={2}
          nodesDraggable={true}
          panOnDrag={true}
          zoomOnScroll={true}
          connectOnClick={false}
          nodesConnectable={false}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--borderFaintColor, rgba(128,128,128,0.1))" gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
