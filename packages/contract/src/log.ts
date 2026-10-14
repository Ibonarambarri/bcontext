/**
 * Structured logging — one JSON line per event. Designed to be ingested by
 * any log shipper (container logs, Better Stack) without further
 * parsing.
 *
 * Every log line carries `request_id` and `correlation_id` when they can be
 * resolved from AsyncLocalStorage (see `correlation.ts`). Bodies are NEVER
 * logged; only event names and a small set of fields.
 *
 * Lines are also forwarded to Better Stack (warn/error by default) when that
 * transport is configured — see `better-stack.ts`. The forward is a no-op
 * when unconfigured, so this stays a pure stdout/stderr logger otherwise.
 */
import { correlationId, requestId } from "./correlation.js";
import { flushBetterStack, shipToBetterStack } from "./better-stack.js";

export type Level = "debug" | "info" | "warn" | "error";

interface Fields {
  [key: string]: unknown;
}

function emit(level: Level, event: string, fields: Fields = {}): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    request_id: requestId(),
    correlation_id: correlationId(),
    ...fields,
  };
  const out = JSON.stringify(line);
  if (level === "error" || level === "warn") {
    process.stderr.write(out + "\n");
  } else {
    process.stdout.write(out + "\n");
  }
  shipToBetterStack(line, level);
}

export const log = {
  debug: (event: string, fields?: Fields) => emit("debug", event, fields),
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
  /** Await delivery of any in-flight Better Stack shipments. */
  flush: () => flushBetterStack(),
};
