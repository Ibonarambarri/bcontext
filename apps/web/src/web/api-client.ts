/**
 * The web app's only way to reach data: the API, over HTTP, as the signed-in
 * person.
 *
 * Server Components and Server Actions call the same routes agents and client
 * components already call, with the request's own session cookie forwarded so
 * the API resolves the grant for the person, never for a service role. There
 * is no data module on this side to import instead — `web-speaks-http.test.ts`
 * enforces that.
 *
 * Where the API is: `API_ORIGIN`, always. There is no API code in this
 * repository to fall back to, so a missing `API_ORIGIN` is a configuration
 * error and says so.
 *
 * Client components keep calling `fetch("/api/…")` relatively; Next proxies
 * those to the API when `API_ORIGIN` is set (`next.config.mjs`).
 */
import { cookies, headers } from "next/headers";

/** A non-2xx answer from the API, with the status and the parsed body kept for the caller. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `api ${status}`);
    this.name = "ApiError";
  }
}

async function forwardedHeaders(init?: HeadersInit): Promise<Headers> {
  const h = new Headers(init);
  const jar = await cookies();
  const cookie = jar
    .getAll()
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
    .join("; ");
  if (cookie) h.set("cookie", cookie);
  // The same-origin guard on state-changing routes compares Origin with the
  // (forwarded) host. A server-side call has no browser to set them, so they
  // are taken from the incoming request: the person's own origin, verbatim.
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host");
  const proto = incoming.get("x-forwarded-proto") ?? "http";
  if (host) {
    h.set("x-forwarded-host", host);
    if (!h.has("origin")) h.set("origin", `${proto}://${host}`);
  }
  return h;
}

/** Raw request to the API, cookie forwarded. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const h = await forwardedHeaders(init.headers);
  if (init.body && typeof init.body === "string" && !h.has("content-type")) {
    h.set("content-type", "application/json");
  }
  const origin = process.env.API_ORIGIN?.replace(/\/$/, "");
  if (!origin) {
    throw new Error("API_ORIGIN is not set — the web app cannot reach the API. See .env.example.");
  }
  return fetch(`${origin}${path}`, { ...init, headers: h, cache: "no-store" });
}

/** JSON in, JSON out; throws ApiError on a non-2xx. */
export async function apiJson<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await apiFetch(path, json === undefined ? rest : { ...rest, body: JSON.stringify(json) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = (body as { error?: unknown; message?: unknown } | null);
    throw new ApiError(res.status, body, typeof msg?.message === "string" ? msg.message : typeof msg?.error === "string" ? msg.error : `api ${res.status}`);
  }
  return body as T;
}

/** 404 → null, everything else as apiJson. For "does this exist for me" reads. */
export async function apiJsonOrNull<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    return await apiJson<T>(path, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
