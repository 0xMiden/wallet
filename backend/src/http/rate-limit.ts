import type { RequestHandler } from 'express';

export interface RateLimitOptions {
  /** Maximum number of requests in a burst. */
  capacity: number;
  /** Tokens added per minute. */
  refillPerMinute: number;
  /** Returns the time in milliseconds. */
  now: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Remove full buckets when the map has more keys than this. */
const PRUNE_THRESHOLD = 10_000;

/** Per-IP token bucket, in memory. Returns 429 when a bucket is empty. */
export function createRateLimit({ capacity, refillPerMinute, now }: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const refillPerMs = refillPerMinute / 60_000;

  function refill(bucket: Bucket, at: number): number {
    return Math.min(capacity, bucket.tokens + (at - bucket.updatedAt) * refillPerMs);
  }

  function prune(at: number): void {
    for (const [key, bucket] of buckets) {
      if (refill(bucket, at) >= capacity) {
        buckets.delete(key);
      }
    }
  }

  return (req, res, next) => {
    const at = now();
    if (buckets.size > PRUNE_THRESHOLD) {
      prune(at);
    }
    const key = req.ip ?? 'unknown';
    const bucket = buckets.get(key);
    const tokens = bucket === undefined ? capacity : refill(bucket, at);
    if (tokens < 1) {
      buckets.set(key, { tokens, updatedAt: at });
      res.setHeader('Retry-After', String(Math.ceil((1 - tokens) / refillPerMs / 1000)));
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    buckets.set(key, { tokens: tokens - 1, updatedAt: at });
    next();
  };
}
