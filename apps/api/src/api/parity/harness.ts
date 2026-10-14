/**
 * Parity between "call the handler directly" and "Hono serves the handler".
 *
 * The handlers are the same functions, so the only thing that can differ is
 * what sits between the wire and the handler: how Hono matches the path,
 * decodes segments, fills params, treats a trailing slash or a dot in the
 * path (`/.well-known/agents.json`), and whether the Response comes back
 * untouched. A parity test builds one request twice, sends one copy to the
 * handler directly with the params the route convention would pass, the
 * other through `app.request()`, and demands the same answer. Anything else
 * is a routing bug in the API process, found here rather than in production.
 *
 * Bodies are read once per Response, so callers compare via the returned
 * snapshots, never the raw responses.
 */
import type { Hono } from "hono";
import { expect } from "vitest";
import type { RouteHandler, RouteModule } from "../adapter";

/** What tests need to state about a request, once. */
export interface ParityRequest {
  method: keyof RouteModule;
  /** Absolute path, params already substituted: `/api/nodes/abc`. */
  path: string;
  /** Params as the route convention hands them to the handler. */
  params?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * Response headers that must also match. Content-type always does; a route
   * whose contract lives in another header — a download's
   * `content-disposition`, a stream's `x-rag-*` sidecar — names it here.
   */
  responseHeaders?: readonly string[];
}

export interface Snapshot {
  status: number;
  contentType: string | null;
  /** Only the headers the request asked for; empty when it asked for none. */
  headers: Record<string, string | null>;
  body: unknown;
}

/** Same-origin guard needs these; every test would otherwise repeat them. */
export const BASE_HEADERS = {
  origin: "http://localhost",
  host: "localhost",
} as const;

export function buildRequest(r: ParityRequest): Request {
  const headers: Record<string, string> = { ...BASE_HEADERS, ...(r.headers ?? {}) };
  let body: string | undefined;
  if (r.body !== undefined) {
    body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    headers["content-type"] ??= "application/json";
  }
  return new Request(`http://localhost${r.path}`, { method: r.method, headers, body });
}

export async function snapshot(res: Response, headerNames: readonly string[] = []): Promise<Snapshot> {
  const contentType = res.headers.get("content-type");
  const headers = Object.fromEntries(headerNames.map((h) => [h.toLowerCase(), res.headers.get(h)]));
  const text = await res.text();
  let body: unknown = text;
  if (contentType?.includes("json") && text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, contentType, headers, body };
}

/**
 * Fields that legitimately differ between two otherwise identical calls and
 * must be blanked before comparing: ids minted per request, timestamps,
 * the correlation ids withRoute assigns.
 */
export const VOLATILE = new Set([
  "id", "ts", "created_at", "updated_at", "request_id", "correlation_id",
  "token", "expires_at", "slug", "position",
]);

export function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        VOLATILE.has(k) ? (v === null ? null : typeof v) : stable(v),
      ]),
    );
  }
  return value;
}

export interface ParityResult {
  direct: Snapshot;
  viaHono: Snapshot;
}

/** Run the same request both ways. The module is the `route.ts` file. */
export async function both(
  app: Hono,
  module: RouteModule,
  r: ParityRequest,
): Promise<ParityResult> {
  const handler = module[r.method] as RouteHandler | undefined;
  if (!handler) throw new Error(`route module has no ${r.method}`);
  const direct = await snapshot(
    await handler(buildRequest(r), { params: Promise.resolve(r.params ?? {}) }),
    r.responseHeaders,
  );
  const viaHono = await snapshot(await app.request(buildRequest(r)), r.responseHeaders);
  return { direct, viaHono };
}

/**
 * The assertion. Status and content-type exactly; body after blanking the
 * volatile fields, because a write executed twice mints two ids and that is
 * not a routing difference.
 */
export function expectParity({ direct, viaHono }: ParityResult): void {
  expect(viaHono.status, `status differs (direct ${direct.status}, hono ${viaHono.status})`).toBe(direct.status);
  expect(viaHono.contentType).toBe(direct.contentType);
  expect(viaHono.headers).toEqual(direct.headers);
  expect(stable(viaHono.body)).toEqual(stable(direct.body));
}

/** Shorthand: run and assert in one call. Returns the direct snapshot for further checks. */
export async function assertParity(app: Hono, module: RouteModule, r: ParityRequest): Promise<Snapshot> {
  const result = await both(app, module, r);
  expectParity(result);
  return result.direct;
}
