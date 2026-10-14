/**
 * The browser's way into the error collector.
 *
 * A page cannot post to the collector directly, and the reason is the whole
 * design of this file: the collector authenticates with `ERRORS_INGEST_KEY`,
 * and a key the browser holds is a key everyone holds — anybody could then
 * write whatever they liked into the table an operator uses to decide what is
 * broken. So the browser posts here, unauthenticated, and this handler — which
 * runs on the server, where the key lives — forwards a report it has rebuilt
 * from scratch. The client chooses the message and the stack; it never chooses
 * `service`, and it never sees the key.
 *
 * Everything else here follows from "this endpoint is open to the internet":
 *
 *   - A size cap, read before parsing. A megabyte of JSON is not a stack.
 *   - A rate limit per IP, in memory. In-memory is the honest scope: this
 *     process is one container and the limit is per container, which is enough
 *     to stop a loop in someone's tab from filling the table and is not
 *     pretending to be a WAF.
 *   - 202 no matter what. There is no answer the browser could act on, and an
 *     error page that reports its error and gets a 400 back is one refresh
 *     away from reporting that too. Refusals are silent by design.
 *
 * Not proxied to the API: `next.config.mjs` rewrites one path per route the
 * contract lists, and this is not one of them — it is genuinely served here.
 */
import { NextResponse } from "next/server";
import { buildReport, type ReportInput } from "@bcontext-dev/contract/error-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Comfortably above a long stack, far below anything worth calling a payload. */
const MAX_BODY_BYTES = 32_000;
/** Per IP, per window. A page in a render loop hits this in a second and is
 *  then silent, which is the correct outcome: the first ten events already
 *  said everything the panel needs. */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string, now = Date.now()): boolean {
  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    // Opportunistic sweep: without it the map is a slow leak keyed by every
    // IP that ever reported. Bounded work, on a path that is already rare.
    if (hits.size > 5_000) {
      for (const [key, value] of hits) if (value.resetAt <= now) hits.delete(key);
    }
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

const accepted = () => NextResponse.json({ ok: true }, { status: 202 });

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/** The only fields a browser is allowed to influence, each clamped. Written as
 *  an explicit pick rather than a spread: a spread would let a caller set
 *  `service`, `level` or `release` and quietly forge rows. */
function sanitize(raw: unknown, req: Request): ReportInput | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const str = (value: unknown, max: number): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

  const message = str(body.message, 2_000);
  if (!message) return null;
  const operation = str(body.operation, 200) ?? "browser:unknown";

  // The error is rebuilt as a real Error so the shared `describeError` handles
  // it exactly as it handles a server-side throw: same `error_type`, same
  // clamping, same fingerprint on the collector's side.
  const error = new Error(message);
  error.name = str(body.error_type, 200) ?? "Error";
  error.stack = str(body.stack, 20_000);

  return {
    operation: operation.startsWith("browser:") ? operation : `browser:${operation}`,
    error,
    level: "error",
    url: str(body.url, 1_000),
    path: str(body.path, 500),
    user_agent: req.headers.get("user-agent")?.slice(0, 500),
    context: {
      release: str(body.release, 80),
      viewport: str(body.viewport, 40),
    },
  };
}

export async function POST(req: Request): Promise<Response> {
  try {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return accepted();
    if (rateLimited(clientIp(req))) return accepted();

    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return accepted();

    const input = sanitize(JSON.parse(text) as unknown, req);
    if (!input) return accepted();

    const url = process.env.ERRORS_INGEST_URL;
    const key = process.env.ERRORS_INGEST_KEY;
    if (!url || !key) return accepted();

    // `buildReport` is the contract's own body builder — same redaction, same
    // clamping, same shape as a report the API sends. `service` is fixed here
    // and nowhere else.
    const report = buildReport(
      {
        url,
        key,
        service: "browser",
        release: process.env.RELEASE_SHA || process.env.SOURCE_COMMIT || undefined,
        environment: process.env.NODE_ENV,
      },
      input,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      await fetch(`${url.replace(/\/$/, "")}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(report),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Malformed JSON, a collector that is down, an aborted fetch — all the
    // same answer. See the module note.
  }
  return accepted();
}
