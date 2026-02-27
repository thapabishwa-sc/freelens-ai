// Shared model name resolution used by both resource and log analysis.

export const MODEL_MAP: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
};

export const DEFAULT_MODEL = "claude-haiku-4-5";

export function resolveModel(model?: string): string {
  if (!model) return DEFAULT_MODEL;
  return MODEL_MAP[model] || model;
}
