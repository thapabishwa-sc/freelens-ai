import { Renderer } from "@freelensapp/extensions";
import { spawn } from "node:child_process";
import { getClusterKubeconfig } from "./cluster-context";
import { logger } from "./logger";

const FLUSH_INTERVAL_MS = 250;
const MAX_BUFFER_SIZE = 512 * 1024; // 512KB — flush immediately if exceeded

// RFC3339 timestamp prefix: "2026-01-15T10:30:00.123456789Z "
const RFC3339_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}) /;

export interface StreamHandle {
  stop(): void;
}

/**
 * Strip the RFC3339 timestamp prefix from a log line.
 * Returns both the raw timestamp string and the stripped text.
 */
export function parseTimestampFromLine(line: string): {
  timestamp: string | undefined;
  text: string;
} {
  const match = RFC3339_PREFIX.exec(line);
  if (!match) return { timestamp: undefined, text: line };
  const timestamp = match[0].trimEnd();
  const text = line.slice(match[0].length);
  return { timestamp, text };
}

/**
 * Parse the first valid RFC3339 timestamp from a block of log content.
 */
export function parseFirstTimestamp(content: string): Date | undefined {
  const newline = content.indexOf("\n");
  const firstLine = newline === -1 ? content : content.slice(0, newline);
  const { timestamp } = parseTimestampFromLine(firstLine);
  if (!timestamp) return undefined;
  const d = new Date(timestamp);
  return isNaN(d.getTime()) ? undefined : d;
}

function getClusterKubectlArgs(): string[] {
  const config = getClusterKubeconfig();
  if (!config) {
    logger.warn("Could not resolve cluster kubeconfig");
    return [];
  }
  const args = ["--kubeconfig", config.kubeconfigPath];
  if (config.contextName) args.push("--context", config.contextName);
  return args;
}

/**
 * Stream pod logs in real-time via `kubectl logs -f`.
 * Buffers chunks and flushes every FLUSH_INTERVAL_MS.
 */
export function streamPodLogs(
  namespace: string,
  podName: string,
  container: string,
  tailLines: number,
  onData: (chunk: string) => void,
  onError: (err: Error) => void,
  previous = false,
  withTimestamps = true,
): StreamHandle {
  const args = [
    ...getClusterKubectlArgs(),
    "logs",
    ...(previous ? [] : ["-f"]),
    podName,
    "-n", namespace,
    "-c", container,
    `--tail=${tailLines}`,
    ...(previous ? ["--previous"] : []),
    ...(withTimestamps ? ["--timestamps"] : []),
  ];

  const proc = spawn("kubectl", args, { stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";

  const flushTimer = setInterval(() => {
    if (buffer) {
      onData(buffer);
      buffer = "";
    }
  }, FLUSH_INTERVAL_MS);

  proc.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    if (buffer.length > MAX_BUFFER_SIZE) {
      onData(buffer);
      buffer = "";
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString("utf-8").trim();
    if (msg && !msg.includes("Unable to use a TTY")) {
      onError(new Error(msg));
    }
  });

  proc.on("error", (err) => onError(err));

  proc.on("close", () => {
    clearInterval(flushTimer);
    if (buffer) {
      onData(buffer);
      buffer = "";
    }
  });

  return {
    stop() {
      clearInterval(flushTimer);
      if (buffer) {
        onData(buffer);
        buffer = "";
      }
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    },
  };
}

/**
 * One-shot pod log fetch via FreeLens API.
 */
export async function getPodLogs(
  namespace: string,
  podName: string,
  container: string,
  tailLines: number,
  previous = false,
  timestamps = true,
): Promise<string> {
  return Renderer.K8sApi.podsApi.getLogs(
    { name: podName, namespace },
    {
      container,
      tailLines: tailLines > 0 ? tailLines : undefined,
      ...(previous ? { previous: true } : {}),
      ...(timestamps ? { timestamps: true } : {}),
    },
  );
}
