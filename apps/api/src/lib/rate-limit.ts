/**
 * Token-bucket rate limiter keyed by `(workspaceId | actorId, scopeClass)`.
 *
 * The backend is in-memory, per process: the API runs as a single
 * container, so one process holds every bucket. A shared backend (Redis) is
 * only needed if that ever becomes several replicas. Failing open is
 * intentional: if the backend misbehaves we serve the request rather than
 * denying.
 *
 * Buckets refill continuously at `refillPerSec`. Each accepted request
 * consumes one token. Denial returns a `retryAfterSec` value the caller
 * surfaces in the `Retry-After` header (RFC 6585).
 */

export type RateLimitScope =
  | "read"
  | "write"
  | "chat"
  | "embed"
  | "user"
  | "public";

interface Budget {
  capacity: number;
  refillPerSec: number;
}

const BUDGETS: Record<RateLimitScope, Budget> = {
  read: { capacity: 120, refillPerSec: 2 },
  write: { capacity: 60, refillPerSec: 1 },
  chat: { capacity: 30, refillPerSec: 0.5 },
  embed: { capacity: 10, refillPerSec: 0.1 },
  user: { capacity: 240, refillPerSec: 4 },
  // Unauthenticated endpoints keyed by IP (signup): a burst of 5,
  // then one request every 30s. Legit users submit once or twice.
  public: { capacity: 5, refillPerSec: 1 / 30 },
};

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  retryAfterSec: number;
  remaining: number;
  capacity: number;
}

/** Consume one token from the `(scope, key)` bucket; `allowed: false` carries `retryAfterSec`. */
export function rateLimit(
  key: string,
  scope: RateLimitScope,
): RateLimitResult {
  const { capacity, refillPerSec } = BUDGETS[scope];
  const now = Date.now();
  const compositeKey = `${scope}:${key}`;
  const bucket = buckets.get(compositeKey) ?? {
    tokens: capacity,
    lastRefill: now,
  };

  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    buckets.set(compositeKey, bucket);
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSec)),
      remaining: 0,
      capacity,
    };
  }

  bucket.tokens -= 1;
  buckets.set(compositeKey, bucket);
  return {
    ok: true,
    retryAfterSec: 0,
    remaining: Math.floor(bucket.tokens),
    capacity,
  };
}

/** Map a scope string to its rate-limit class. */
export function scopeClass(scope: string | undefined): RateLimitScope {
  if (!scope) return "user";
  if (scope === "chat:run") return "chat";
  if (scope.endsWith(":write")) return "write";
  if (scope.endsWith(":read")) return "read";
  if (scope === "admin:*") return "write";
  return "user";
}

/** Test-only: clear all buckets. */
export function _resetRateLimit(): void {
  buckets.clear();
}
