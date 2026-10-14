/**
 * Better Stack (Telemetry) log transport. Ships log lines to the Better Stack
 * HTTP ingestion API so production failures surface in the dashboard the
 * moment they happen.
 *
 * Activates only when BETTER_STACK_SOURCE_TOKEN and BETTER_STACK_INGESTING_URL
 * are set — otherwise every call is a no-op, so local/dev and unconfigured
 * deploys pay nothing. By default only `warn`/`error` are shipped (override
 * with BETTER_STACK_MIN_LEVEL) to keep volume and cost low.
 *
 * Shipping is fire-and-forget with `keepalive: true` so an in-flight request
 * survives the handler returning its response — a plain container has
 * no native log drain. Errors are swallowed: telemetry must
 * never throw or block a request. Callers that can await — cron handlers, the
 * `onRequestError` hook — should `await flushBetterStack()` before exiting to
 * guarantee delivery.
 */
import type { Level } from "./log.js";

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minRank(): number {
  const raw = (process.env.BETTER_STACK_MIN_LEVEL || "warn").toLowerCase();
  return RANK[raw as Level] ?? RANK.warn;
}

const inFlight = new Set<Promise<unknown>>();

export function shipToBetterStack(
  line: Record<string, unknown>,
  level: Level,
): void {
  const token = process.env.BETTER_STACK_SOURCE_TOKEN;
  const host = process.env.BETTER_STACK_INGESTING_URL;
  if (!token || !host) return;
  if (RANK[level] < minRank()) return;

  const url = host.startsWith("http") ? host : `https://${host}`;
  // Better Stack searches the `message` field and reads `dt` as the event
  // timestamp; everything else on the line is kept as a structured attribute.
  const body = JSON.stringify({ dt: line.ts, message: line.event, ...line });

  const p = fetch(url, {
    method: "POST",
    keepalive: true,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
  })
    .catch(() => {
      // Never let telemetry break the app.
    })
    .finally(() => {
      inFlight.delete(p);
    });
  inFlight.add(p);
}

/** Await any in-flight shipments. No-op when nothing is pending. */
export async function flushBetterStack(): Promise<void> {
  if (inFlight.size === 0) return;
  await Promise.allSettled([...inFlight]);
}
