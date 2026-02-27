/** Status codes that are safe to retry */
const RETRYABLE_STATUS_CODES = new Set([429, 503, 529]);

/** Status codes that should never be retried */
const NON_RETRYABLE_STATUS_CODES = new Set([400, 403]);

/** Backoff delays in ms for each retry attempt */
const BACKOFF_DELAYS = [2000, 6000];

/**
 * Retry a function with exponential backoff.
 * Only retries on transient errors (429, 503, 529, network errors).
 * On 401, calls onUnauthorized to attempt token refresh before retrying.
 * Respects AbortSignal for cancellation.
 */
export async function retryWithBackoff<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  maxRetries = 2,
  onUnauthorized?: () => Promise<boolean>,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return await fn(signal);
    } catch (err: any) {
      lastError = err;

      // Don't retry abort errors
      if (err.name === "AbortError") throw err;

      const status = err.status || err.statusCode;

      // Don't retry non-retryable HTTP status codes
      if (status && NON_RETRYABLE_STATUS_CODES.has(status)) throw err;

      // On 401, attempt token refresh then retry immediately
      if (status === 401 && onUnauthorized && attempt < maxRetries) {
        const refreshed = await onUnauthorized();
        if (refreshed) continue; // retry with new token, no backoff
        throw err; // refresh failed, don't retry
      }

      // Only retry retryable status codes or network errors
      const isRetryable = (status && RETRYABLE_STATUS_CODES.has(status))
        || !status  // network error (no status code)
        || err.code === "ECONNRESET"
        || err.code === "ETIMEDOUT";

      if (!isRetryable || attempt >= maxRetries) throw err;

      // Wait with backoff
      const delay = BACKOFF_DELAYS[attempt] || BACKOFF_DELAYS[BACKOFF_DELAYS.length - 1];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        if (signal) {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
  }

  throw lastError || new Error("Retry failed");
}
