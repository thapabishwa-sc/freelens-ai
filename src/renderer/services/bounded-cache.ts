import { getActiveClusterId } from "./cluster-context";

interface CacheEntry<T> {
  timestamp: number;
  data: T;
}

/**
 * A generic bounded cache with cluster scoping and TTL eviction.
 *
 * - Keys are automatically prefixed with the active cluster ID
 * - Entries expire after `ttlMs` milliseconds
 * - When the cache exceeds `maxSize`, the oldest entries are evicted
 */
export class BoundedCache<T> {
  private map = new Map<string, CacheEntry<T>>();
  private readonly getTtlMs: () => number;

  constructor(
    ttlMs: number | (() => number),
    private readonly maxSize = 200,
  ) {
    this.getTtlMs = typeof ttlMs === "function" ? ttlMs : () => ttlMs;
  }

  private scopedKey(key: string): string {
    return `${getActiveClusterId()}:${key}`;
  }

  get(key: string): { data: T; timestamp: number } | null {
    const sk = this.scopedKey(key);
    const entry = this.map.get(sk);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.getTtlMs()) {
      this.map.delete(sk);
      return null;
    }

    return { data: entry.data, timestamp: entry.timestamp };
  }

  set(key: string, data: T): void {
    const sk = this.scopedKey(key);

    // Evict oldest entries if at capacity (Map preserves insertion order)
    while (this.map.size >= this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      } else {
        break;
      }
    }

    this.map.set(sk, { timestamp: Date.now(), data });
  }

  delete(key: string): void {
    this.map.delete(this.scopedKey(key));
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
