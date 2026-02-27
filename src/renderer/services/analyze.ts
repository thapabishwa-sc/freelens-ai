import { Renderer } from "@freelensapp/extensions";
import { getClient, tryRefreshAuth } from "./claude-client";
import { buildResourceContext } from "./context-builders";
import { discoverRelationships, formatRelationships, type ResourceRelationships } from "./relationship-discovery";
import { retryWithBackoff } from "./retry";
import { getConfig } from "./config";
import { BoundedCache } from "./bounded-cache";
import { resolveModel } from "./models";

type KubeObject = Renderer.K8sApi.KubeObject;

// ── Types ──

export interface ResourceIssue {
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  detail: string;
}

export interface ResourceAnalysis {
  health: "healthy" | "warning" | "critical" | "unknown";
  summary: string;
  issues: ResourceIssue[];
  recommendations: string[];
  relatedResources: string[];
  relationships?: ResourceRelationships;
}

export type AnalysisState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: ResourceAnalysis; cachedAt: number }
  | { status: "error"; error: string };

// ── Cache (cluster-scoped, bounded) ──

const cache = new BoundedCache<ResourceAnalysis>(() => getConfig().resourceCacheTtlMs);

export function getCachedAnalysis(uid: string): { data: ResourceAnalysis; timestamp: number } | null {
  return cache.get(uid);
}

export function invalidateCache(uid?: string): void {
  if (uid) {
    cache.delete(uid);
  } else {
    cache.clear();
  }
}

// ── JSON Schema ──

const ANALYSIS_SCHEMA = {
  type: "object" as const,
  required: ["health", "summary", "issues", "recommendations", "relatedResources"],
  properties: {
    health: { type: "string" as const, enum: ["healthy", "warning", "critical", "unknown"] },
    summary: { type: "string" as const },
    issues: {
      type: "array" as const,
      items: {
        type: "object" as const,
        required: ["description", "severity", "detail"],
        properties: {
          description: { type: "string" as const },
          severity: { type: "string" as const, enum: ["critical", "high", "medium", "low"] },
          detail: { type: "string" as const },
        },
        additionalProperties: false,
      },
    },
    recommendations: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    relatedResources: {
      type: "array" as const,
      items: { type: "string" as const },
    },
  },
  additionalProperties: false,
};

// ── System Prompt ──

const SYSTEM_PROMPT = `You are a Kubernetes operations expert. You analyze Kubernetes resources and provide actionable diagnostics.

You receive two types of context:
1. **Resource details** — the spec, status, conditions, logs, and events of the target resource
2. **Related resources** — dynamically discovered relationships including:
   - Owner chain (who owns this resource, and their owners)
   - Owned/child resources (what this resource controls)
   - Selector targets (pods/services matched by label selectors)
   - Spec references (secrets, configmaps, services, CRD cross-references found in the spec)

Guidelines:
- Be concise and specific. Focus on issues that need attention.
- Reference specific field values as evidence for any issues you identify.
- Analyze the relationship graph: are children healthy? Is the owner in a good state? Do selectors match the expected resources?
- For health assessment: "healthy" = no issues, "warning" = non-critical issues, "critical" = requires immediate attention, "unknown" = insufficient data.
- If there are no issues, say so briefly and set health to "healthy" with an empty issues array.
- For recommendations, provide specific kubectl commands or actions when applicable.
- For relatedResources, list the most relevant K8s resources to investigate next, using "Kind/name" format (e.g., "Service/my-svc", "Pod/worker-0"). Prioritize resources that appear unhealthy or are part of the issue.
- Never expose secret values. If analyzing a Secret, only discuss the structure and type.
- For CRDs you don't recognize, analyze the spec/status structure and conditions generically. Look for common patterns (conditions, replicas, phase, ready status).`;

// ── Model Map ──

// ── Analyze ──

export async function analyzeResource(
  kind: string,
  object: KubeObject,
  model?: string,
  signal?: AbortSignal,
): Promise<ResourceAnalysis> {
  const uid = (object as any).metadata?.uid || `${kind}/${(object as any).metadata?.namespace || ""}/${(object as any).metadata?.name}`;

  // Check cache
  const cached = getCachedAnalysis(uid);
  if (cached) return cached.data;

  // Build context and discover relationships in parallel
  const [context, relationships] = await Promise.all([
    buildResourceContext(kind, object),
    discoverRelationships(object),
  ]);

  const relationshipContext = formatRelationships(relationships);

  const name = (object as any).metadata?.name || "unknown";
  const namespace = (object as any).metadata?.namespace;

  const userMessage = `Analyze this ${kind} resource:

Name: ${name}${namespace ? `\nNamespace: ${namespace}` : ""}

${context}${relationshipContext}

Provide a health assessment, issues found, and recommendations. Consider the relationship graph in your analysis.`;

  const resolvedModel = resolveModel(model);

  const config = getConfig();

  const data = await retryWithBackoff(async (sig) => {
    const client = await getClient();

    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), config.apiTimeoutMs);

    const onAbort = () => timeoutCtrl.abort();
    if (sig) {
      sig.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const response = await client.messages.create({
        model: resolvedModel,
        max_tokens: config.analysisMaxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        output_config: {
          format: {
            type: "json_schema" as const,
            schema: ANALYSIS_SCHEMA,
          },
        },
      } as any, { signal: timeoutCtrl.signal });

      const text = response.content[0]?.type === "text" ? response.content[0].text : "";

      let result: ResourceAnalysis;
      try {
        result = JSON.parse(text) as ResourceAnalysis;
      } catch {
        throw new Error("AI returned an unexpected response. Please try again.");
      }

      return result;
    } finally {
      clearTimeout(timer);
      sig?.removeEventListener("abort", onAbort);
    }
  }, signal, 2, tryRefreshAuth);

  // Attach raw relationship data for graph visualization
  data.relationships = relationships;

  // Cache it
  cache.set(uid, data);

  return data;
}
