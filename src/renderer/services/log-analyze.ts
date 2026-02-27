import { Renderer } from "@freelensapp/extensions";
import { getClient, tryRefreshAuth } from "./claude-client";
import { retryWithBackoff } from "./retry";
import { getConfig } from "./config";
import { BoundedCache } from "./bounded-cache";
import { resolveModel } from "./models";
import { safeRegex, safeRegexTest } from "../utils/safe-regex";

// ── Types ──

export interface LogPattern {
  pattern: string;
  count: number;
  severity: "error" | "warning" | "info";
  example: string;
}

export interface LogAnomaly {
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  timeRange?: string;
  detail: string;
}

export interface LogPatternRegex {
  regex: string;
  level: "error" | "warning" | "info" | "critical";
  label: string;
  description: string;
}

export interface LogAnalysis {
  summary: string;
  health: "healthy" | "warning" | "critical" | "unknown";
  patterns: LogPattern[];
  anomalies: LogAnomaly[];
  recommendations: string[];
  errorCount: number;
  warningCount: number;
  patternRegexes?: LogPatternRegex[];
}

export type LogAnalysisState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: LogAnalysis; cachedAt: number }
  | { status: "error"; error: string };

// ── Cache (cluster-scoped, bounded) ──

interface LogCacheData {
  analysis: LogAnalysis;
  logLines: string[];
}

const cache = new BoundedCache<LogCacheData>(() => getConfig().logCacheTtlMs);

function getCacheKey(namespace: string, podName: string, container?: string): string {
  return `logs/${namespace}/${podName}${container ? `/${container}` : ""}`;
}

function getCachedLogAnalysis(key: string): { data: LogAnalysis; timestamp: number } | null {
  const entry = cache.get(key);
  if (!entry) return null;
  return { data: entry.data.analysis, timestamp: entry.timestamp };
}

/** Return the cached log lines for a given pod, used for pattern dedup. */
export function getCachedLogLines(namespace: string, podName: string, container?: string): string[] {
  const key = getCacheKey(namespace, podName, container);
  const entry = cache.get(key);
  return entry?.data.logLines || [];
}

/** Clear the entire log analysis cache. */
export function clearLogCache(): void {
  cache.clear();
}

// ── JSON Schema ──

const LOG_ANALYSIS_SCHEMA = {
  type: "object" as const,
  required: ["summary", "health", "patterns", "anomalies", "recommendations", "errorCount", "warningCount"],
  properties: {
    summary: { type: "string" as const },
    health: { type: "string" as const, enum: ["healthy", "warning", "critical", "unknown"] },
    patterns: {
      type: "array" as const,
      items: {
        type: "object" as const,
        required: ["pattern", "count", "severity", "example"],
        properties: {
          pattern: { type: "string" as const },
          count: { type: "number" as const },
          severity: { type: "string" as const, enum: ["error", "warning", "info"] },
          example: { type: "string" as const },
        },
        additionalProperties: false,
      },
    },
    anomalies: {
      type: "array" as const,
      items: {
        type: "object" as const,
        required: ["description", "severity", "detail"],
        properties: {
          description: { type: "string" as const },
          severity: { type: "string" as const, enum: ["critical", "high", "medium", "low"] },
          timeRange: { type: "string" as const },
          detail: { type: "string" as const },
        },
        additionalProperties: false,
      },
    },
    recommendations: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    errorCount: { type: "number" as const },
    warningCount: { type: "number" as const },
    patternRegexes: {
      type: "array" as const,
      items: {
        type: "object" as const,
        required: ["regex", "level", "label", "description"],
        properties: {
          regex: { type: "string" as const },
          level: { type: "string" as const, enum: ["error", "warning", "info", "critical"] },
          label: { type: "string" as const },
          description: { type: "string" as const },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

// ── System Prompt ──

const LOG_SYSTEM_PROMPT = `You are a Kubernetes log analysis expert. You analyze container logs and identify patterns, anomalies, and actionable insights.

You receive the recent logs from a running container, along with pod context (resource specs, container status, restart history, and recent events when available). Your job is to:

1. **Pattern Detection**: Identify recurring log patterns and classify them:
   - "error": Error messages, exceptions, stack traces, failures
   - "warning": Warnings, deprecations, retries, timeouts
   - "info": Notable informational patterns (startup, shutdown, config changes)
   Group similar messages and count occurrences. Show one example per pattern.

2. **Anomaly Detection**: Find unusual or concerning patterns:
   - Sudden error spikes or new error types
   - Unusual timing patterns (long gaps, rapid repetition)
   - Resource issues (OOM, disk, connection failures) — correlate with container memory/CPU limits if provided
   - Security concerns (auth failures, unexpected access)
   - If restart count is high, look for crash loops or OOM patterns in the logs
   - If exit codes are non-zero, identify what caused the termination

3. **Health Assessment**: Overall log health:
   - "healthy": No errors, normal operation
   - "warning": Some warnings or minor errors, but generally functional
   - "critical": Frequent errors, crashes, or service disruption
   - "unknown": Not enough data or unclear
   Factor in pod events (e.g., OOMKilled, BackOff, Evicted) and restart counts when assessing health.

4. **Recommendations**: Actionable next steps based on the logs AND pod context. For example:
   - If OOM errors appear and memory limits are set, suggest specific limit increases
   - If pods are crash-looping, recommend checking the specific failing component
   - Reference actual resource values when making resource-related suggestions

5. **Pattern Regexes**: ONLY extract regexes for log lines that indicate a real operational problem — errors, failures, performance degradation, or resource exhaustion. Be extremely selective. Do NOT create patterns for:
   - Normal operational logs (startup, shutdown, scheduled tasks, routine activity)
   - Informational messages that don't indicate a problem
   - Anything that is expected behavior

   Keep regexes simple, specific, and correct JavaScript regex syntax. Examples:
   - For timeout errors: "timeout|timed out|connection timed out"
   - For OOM: "OutOfMemoryError|OOM|oom.?kill"
   - For auth failures: "auth.*fail|unauthorized|403 forbidden"
   Assign each regex the CORRECT severity level:
   - "critical": Service down, data loss, crash loops, OOM kills, pod evictions
   - "error": Exceptions, stack traces, connection failures, auth failures, 5xx responses
   - "warning": Slow queries, high latency, retries, deprecations, approaching limits
   NEVER use "info" — if it's just informational, don't create a pattern for it. Use "error" for actual errors and exceptions. Use "critical" only for service-impacting failures.

Guidelines:
- Be concise and specific. Reference actual log content.
- Count errors and warnings accurately.
- If logs look normal with no issues, say so briefly.
- Focus on what's actionable — skip routine info logs.
- Never expose secrets or sensitive data found in logs.
- Only generate pattern regexes for genuinely concerning log lines. Quality over quantity — 1-3 high-signal patterns are better than 10 noisy ones. Return an empty array if the logs look healthy.`;

// ── Log Truncation ──

// ~120K chars ≈ ~30K tokens, leaves plenty of headroom under 200K token limit
const MAX_LOG_CHARS = 120_000;
const MAX_LINE_LENGTH = 2000;

function truncateLogs(logs: string): string {
  let lines = logs.split("\n");

  // Truncate excessively long lines (e.g. JSON blobs)
  lines = lines.map((line) =>
    line.length > MAX_LINE_LENGTH
      ? line.slice(0, MAX_LINE_LENGTH) + " ...[truncated]"
      : line,
  );

  let result = lines.join("\n");

  if (result.length > MAX_LOG_CHARS) {
    // Keep the most recent (tail) logs — they're most relevant for analysis
    result = result.slice(result.length - MAX_LOG_CHARS);
    // Find first newline to avoid cutting mid-line
    const firstNL = result.indexOf("\n");
    if (firstNL > 0 && firstNL < MAX_LOG_CHARS * 0.2) {
      result = result.slice(firstNL + 1);
    }
    result = "...[truncated — older logs exceeded size limit]\n" + result;
  }

  return result;
}

// ── Fetch Logs ──

export async function fetchPodLogs(
  namespace: string,
  podName: string,
  container?: string,
  tailLines?: number,
): Promise<string> {
  if (tailLines === undefined) tailLines = getConfig().logTailLines;
  const params: Record<string, any> = { tailLines, timestamps: true };
  if (container) params.container = container;

  const logs = await Renderer.K8sApi.podsApi.getLogs(
    { name: podName, namespace },
    params,
  );

  return truncateLogs(logs || "");
}

// ── Pattern Validation ──

const MIN_PATTERN_MATCHES = 3;

function validatePatternRegexes(
  patterns: LogPatternRegex[] | undefined,
  logLines: string[],
): LogPatternRegex[] {
  if (!patterns || patterns.length === 0) return [];

  return patterns.filter((p) => {
    const regex = safeRegex(p.regex);
    if (!regex) return false; // Invalid or potentially dangerous regex

    let matchCount = 0;
    for (const line of logLines) {
      if (safeRegexTest(regex, line)) {
        matchCount++;
        if (matchCount >= MIN_PATTERN_MATCHES) return true;
      }
    }
    return false;
  });
}

// ── Pod Context for Smarter Analysis ──

async function fetchPodContext(namespace: string, podName: string): Promise<string> {
  const lines: string[] = [];

  // Fetch pod object
  try {
    const api = Renderer.K8sApi.podsApi as any;
    const pod = await api.request.get(`/api/v1/namespaces/${namespace}/pods/${podName}`);
    if (!pod) return "";

    const status = pod.status || {};
    const spec = pod.spec || {};

    // Phase & restarts
    lines.push(`Pod Phase: ${status.phase || "Unknown"}`);

    const containerStatuses = status.containerStatuses || [];
    for (const cs of containerStatuses) {
      const parts = [`${cs.name}: ready=${cs.ready}, restarts=${cs.restartCount}`];

      // Current state
      if (cs.state) {
        const stateKey = Object.keys(cs.state)[0];
        const stateVal = cs.state[stateKey];
        parts.push(`state=${stateKey}${stateVal?.reason ? ` (${stateVal.reason})` : ""}`);
      }

      // Last termination (exit code, reason)
      if (cs.lastState?.terminated) {
        const t = cs.lastState.terminated;
        parts.push(`lastTerminated: exitCode=${t.exitCode}${t.reason ? ` (${t.reason})` : ""}${t.signal ? ` signal=${t.signal}` : ""}`);
      }

      lines.push(`  Container ${parts.join(", ")}`);
    }

    // Resource limits/requests (helps correlate OOM, throttling)
    const containers = spec.containers || [];
    for (const c of containers) {
      const req = c.resources?.requests;
      const lim = c.resources?.limits;
      if (req || lim) {
        const parts: string[] = [`  Resources for ${c.name}:`];
        if (req) parts.push(`    requests: cpu=${req.cpu || "—"}, memory=${req.memory || "—"}`);
        if (lim) parts.push(`    limits: cpu=${lim.cpu || "—"}, memory=${lim.memory || "—"}`);
        lines.push(parts.join("\n"));
      }
    }

    // Conditions (shows scheduling issues, readiness problems)
    const conditions = status.conditions || [];
    const problemConditions = conditions.filter(
      (c: any) => c.status !== "True" || c.type === "Ready",
    );
    if (problemConditions.length > 0) {
      lines.push("Conditions:");
      for (const c of problemConditions) {
        lines.push(`  ${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ""}${c.message ? `: ${c.message}` : ""}`);
      }
    }
  } catch { /* pod fetch failed — continue without context */ }

  // Fetch recent events
  try {
    const api = Renderer.K8sApi.podsApi as any;
    const path = `/api/v1/namespaces/${namespace}/events?fieldSelector=involvedObject.name=${podName},involvedObject.kind=Pod`;
    const response = await api.request.get(path);
    const events = response?.items || [];

    // Only include Warning events or notable Normal events
    const relevant = events.filter(
      (e: any) => e.type === "Warning" || (e.reason && /Killed|OOM|BackOff|Unhealthy|FailedScheduling|Evicted/.test(e.reason)),
    );

    if (relevant.length > 0) {
      lines.push("Recent Pod Events:");
      for (const e of relevant.slice(-10)) {
        lines.push(`  [${e.type}] ${e.reason}: ${e.message} (${e.count || 1}x)`);
      }
    }
  } catch { /* events fetch failed */ }

  return lines.join("\n");
}

// ── Analyze ──

export async function analyzeLogsFn(
  namespace: string,
  podName: string,
  container?: string,
  model?: string,
  force?: boolean,
  signal?: AbortSignal,
): Promise<LogAnalysis> {
  const cacheKey = getCacheKey(namespace, podName, container);

  if (!force) {
    const cached = getCachedLogAnalysis(cacheKey);
    if (cached) return cached.data;
  }

  // Fetch logs and pod context in parallel
  const [logs, podContext] = await Promise.all([
    fetchPodLogs(namespace, podName, container),
    fetchPodContext(namespace, podName),
  ]);

  if (!logs.trim()) {
    return {
      summary: "No logs available for this container.",
      health: "unknown",
      patterns: [],
      anomalies: [],
      recommendations: ["Check if the container is running and producing output."],
      errorCount: 0,
      warningCount: 0,
    };
  }

  const resolvedModel = resolveModel(model);

  const userMessage = `Analyze the following container logs:

Pod: ${podName}
Namespace: ${namespace}${container ? `\nContainer: ${container}` : ""}
Lines: ${logs.split("\n").length}
${podContext ? `\n--- POD CONTEXT ---\n${podContext}\n--- END POD CONTEXT ---\n` : ""}
--- LOGS START ---
${logs}
--- LOGS END ---

Provide pattern analysis, anomaly detection, and recommendations.${podContext ? " Correlate log patterns with the pod context above (resource limits, restart history, events) where relevant." : ""}`;

  const config = getConfig();

  const data = await retryWithBackoff(async (sig) => {
    const client = await getClient();

    // Create a timeout abort if no external signal
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), config.apiTimeoutMs);

    // Combine external signal with timeout
    const onAbort = () => timeoutCtrl.abort();
    if (sig) {
      sig.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const response = await client.messages.create({
        model: resolvedModel,
        max_tokens: config.analysisMaxTokens,
        system: LOG_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        output_config: {
          format: {
            type: "json_schema" as const,
            schema: LOG_ANALYSIS_SCHEMA,
          },
        },
      } as any, { signal: timeoutCtrl.signal });

      const text = response.content[0]?.type === "text" ? response.content[0].text : "";

      try {
        return JSON.parse(text) as LogAnalysis;
      } catch {
        throw new Error("AI returned an unexpected response. Please try again.");
      }
    } finally {
      clearTimeout(timer);
      sig?.removeEventListener("abort", onAbort);
    }
  }, signal, 2, tryRefreshAuth);

  // Split log lines once for validation and caching
  const logLines = logs.split("\n");

  // Validate pattern regexes against actual log lines before storing
  if (data.patternRegexes && data.patternRegexes.length > 0) {
    data.patternRegexes = validatePatternRegexes(data.patternRegexes, logLines);
  }

  // Cache (include log lines for pattern dedup)
  cache.set(cacheKey, { analysis: data, logLines });

  return data;
}
