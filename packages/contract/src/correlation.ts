/**
 * Request- and correlation-ID propagation via AsyncLocalStorage.
 *
 *   - `request_id` is unique per HTTP request. Returned on `X-Request-Id`.
 *   - `correlation_id` is supplied by the client when it wants to group a
 *     multi-step agent run; if absent we generate one. Returned on
 *     `X-Correlation-Id`.
 *
 * Routes wrap their handler with `runWithIds(req, () => handler(req))` —
 * inside that closure, `log()` and helpers automatically pick up both IDs.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface Store {
  requestId: string;
  correlationId: string;
  /**
   * Fields the handler learns about the request after logging has started
   * and wants on the `request.completed` line: which MCP tool ran, for whom,
   * how many bytes went out. Mutable on purpose — the route wrapper reads it
   * once, when the response is known.
   */
  annotations: Record<string, unknown>;
}

const als = new AsyncLocalStorage<Store>();

export function runWithIds<T>(
  ids: { requestId: string; correlationId: string },
  fn: () => T,
): T {
  return als.run({ ...ids, annotations: {} }, fn);
}

/**
 * Attach fields to the current request's completion log line. Outside a
 * request context this is a no-op, so library code can call it without
 * knowing whether an HTTP request is in flight. `undefined` values are
 * dropped so callers can pass optional fields without checking them first.
 */
export function annotateRequest(fields: Record<string, unknown>): void {
  const store = als.getStore();
  if (!store) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) store.annotations[key] = value;
  }
}

/** The fields attached so far, or `{}` outside a request context. */
export function requestAnnotations(): Record<string, unknown> {
  return { ...(als.getStore()?.annotations ?? {}) };
}

export function requestId(): string | undefined {
  return als.getStore()?.requestId;
}

export function correlationId(): string | undefined {
  return als.getStore()?.correlationId;
}

/**
 * Extract both IDs from a request, generating them if missing.
 */
export function idsFromRequest(req: Request): {
  requestId: string;
  correlationId: string;
} {
  const requestId = req.headers.get("x-request-id") || crypto.randomUUID();
  const correlationId =
    req.headers.get("x-correlation-id") || crypto.randomUUID();
  return { requestId, correlationId };
}
