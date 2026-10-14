/**
 * The collector's one write path: a report in, a row in `error_groups` and
 * maybe a row in `error_events` out.
 *
 * WHY ITS OWN POOL
 *   `src/lib/queue/db.ts` owns the pool for the worker: pg-boss holds
 *   long-lived connections, runs `LISTEN/NOTIFY`, and its `withTransaction`
 *   hands clients around so a job row commits with the write that caused it.
 *   None of that is this process's business, and sharing the module would tie
 *   the collector's connection budget and lifecycle to the queue's. The two
 *   also never run in the same process — `BCONTEXT_PROCESS` picks one — so
 *   "reuse" would only ever have meant "coupled for nothing". What IS shared
 *   is `sslFor`: the loopback-versus-pooler guess is a property of the
 *   deployment, not of the caller, and having two copies of it is exactly how
 *   the worker once died on a local Supabase that speaks no TLS.
 *
 * WHY THE POOL IS TINY
 *   Four connections by default. The collector is a sink: one INSERT-ish call
 *   per report, no reads, no transactions held open. Its failure mode is an
 *   incident — the moment it matters is the moment every process is throwing
 *   at once — and the last thing a database in trouble needs is the error
 *   collector opening fifty connections to write about it. The rate limiter
 *   in `app.ts` and the per-minute sampling in `record_error_event` are the
 *   other two brakes on the same runaway.
 *
 * WHY ONE SQL CALL
 *   `record_error_event` does the group upsert, the sampling decision and the
 *   event insert atomically (see 0074). Splitting it into two round trips
 *   would let two collector replicas both create the group and split the
 *   sampling budget between them.
 *
 * Nothing in this file's import graph may reach `next/*` — `build:errors`
 * fails if it does.
 */
import { Pool } from "pg";
import type { ErrorReport } from "@bcontext-dev/contract/errors";
import { ERROR_CONTEXT_MAX } from "@bcontext-dev/contract/errors";
import { sslFor } from "@/lib/queue/ssl";
import { fingerprintFor } from "./fingerprint";

/**
 * Keys whose values never reach the table, wherever they sit in `context`.
 * The reporter redacts too (`packages/contract/src/error-report.ts`), and this
 * is the copy that matters: reporters are many, versioned independently, and
 * one of them is a browser we do not control the deploy of. The check is on
 * the KEY because values are unknowable and keys are how people label
 * secrets — one stray `{ ...opts }` with a token in it would otherwise put a
 * live credential in a table the whole admin panel reads.
 */
const SECRET_KEY = /(token|key|secret|password|authorization|cookie|credential)/i;
const REDACTED = "[redacted]";

/** How deep the redaction walks. Three levels covers every context anybody
 *  builds by hand; deeper than that is a payload somebody attached, and the
 *  size cap below is the answer to those. */
const REDACT_MAX_DEPTH = 3;

/** What `record_error_event` reports back. `stored: false` is not a failure —
 *  it is the per-minute sampling saying the counter was incremented but the
 *  row was not kept. */
export interface RecordResult {
  fingerprint: string;
  groupId: string;
  stored: boolean;
  eventCount: number;
}

let pool: Pool | null = null;

export function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Lazily-built pool, `application_name` set so that a `pg_stat_activity`
 * during an incident says which process is holding what. Lazy rather than
 * built at import so the module can be imported by a test that never touches
 * a database.
 */
function getErrorsPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  pool = new Pool({
    connectionString,
    max: Number(process.env.ERRORS_POOL_MAX ?? 4),
    application_name: "bcontext-errors",
    ssl: sslFor(connectionString),
  });
  // A pool that emits `error` with nobody listening takes the process down —
  // and this process exists so that other processes' failures are survivable.
  // Swallowing is correct here: `pg` discards the broken client itself and
  // the next call opens a new one.
  pool.on("error", () => {});
  return pool;
}

export async function closeErrorsPool(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await current.end();
}

/** `/readyz` asks this. Cheap on purpose: the question is "can I reach the
 *  database at all", not "is it fast". */
export async function pingDb(): Promise<boolean> {
  try {
    await getErrorsPool().query("select 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * `context` with credentials removed and its serialised size capped.
 *
 * The cap is on the SERIALISED form because that is what Postgres stores and
 * what the panel later renders; capping the object's key count would let one
 * 400 KB string through. Over the cap the whole thing is replaced by a marker
 * plus a prefix rather than being dropped: an operator who sees
 * `_truncated: true` knows to go and look at the log line, whereas a missing
 * field looks like the reporter never sent one.
 */
function sanitizeContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const redacted = redact(context, 0);
  const json = safeJson(redacted);
  if (json === undefined) {
    // Circular, or a BigInt somebody put in a context object. Do not lose the
    // event over it.
    return { _unserializable: true };
  }
  if (json.length <= ERROR_CONTEXT_MAX) return redacted;
  return {
    _truncated: true,
    _size: json.length,
    _preview: json.slice(0, ERROR_CONTEXT_MAX),
  };
}

function redact(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item) && depth < REDACT_MAX_DEPTH) {
      out[key] = redact(item as Record<string, unknown>, depth + 1);
      continue;
    }
    out[key] = item;
  }
  return out;
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Rows `record_error_event` returns, before they are given names a caller
 *  can read. `event_count` is a bigint, and `pg` hands bigints back as text
 *  so as not to lose precision — hence the `Number()` below. */
interface RecordRow {
  group_id: string;
  stored: boolean;
  event_count: string | number;
}

/**
 * Record one occurrence. Throws if the database is unreachable — the HTTP
 * layer above decides what to do about that, and what it decides is "answer
 * 202 anyway" (see `app.ts`).
 */
export async function recordEvent(report: ErrorReport): Promise<RecordResult> {
  const fingerprint = fingerprintFor(report);
  // The payload goes in as one jsonb rather than thirty parameters: the field
  // list grows, and a thirty-argument signature is a migration every time it
  // does. `record_error_event` picks the columns out of it.
  const payload = { ...report, context: sanitizeContext(report.context) };
  const sampleCap = Number(process.env.ERRORS_SAMPLE_CAP ?? 5);

  const res = await getErrorsPool().query(
    "select group_id, stored, event_count from public.record_error_event($1, $2::jsonb, $3)",
    [fingerprint, JSON.stringify(payload), sampleCap],
  );
  const row = res.rows[0] as RecordRow | undefined;
  return {
    fingerprint,
    groupId: row?.group_id ?? "",
    stored: Boolean(row?.stored),
    eventCount: Number(row?.event_count ?? 0),
  };
}
