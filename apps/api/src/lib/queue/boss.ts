/**
 * pg-boss lifecycle.
 *
 * One module owns the instance so both the worker process and the request
 * path (which only ever *sends*) talk to the same configuration. Split into
 * small exported steps so the tests can exercise registration and scheduling
 * without a live database.
 */
import { PgBoss } from "pg-boss";
import { log } from "@bcontext-dev/contract/log";
import { databaseUrl } from "./db";
import { QUEUES, type QueueDefinition } from "./queues";
import { HANDLERS } from "./handlers";
import { sslFor } from "./ssl";
import { reportWorkerError } from "@/lib/errors/report";

/** Schema pg-boss owns. Kept out of `public` so it never collides with the domain. */
const PGBOSS_SCHEMA = process.env.PGBOSS_SCHEMA || "pgboss";

let instance: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

export type BossRole = "worker" | "producer";

/**
 * `producer` is the request path: it only ever calls `send`, so it must not
 * run maintenance, the cron scheduler or the migrator — otherwise every API
 * instance would fight the worker over the same background work.
 */
export function createBoss(role: BossRole = "producer"): PgBoss {
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set — pg-boss cannot start");
  }
  return new PgBoss({
    connectionString,
    schema: PGBOSS_SCHEMA,
    max: Number(process.env.PGBOSS_POOL_MAX ?? 3),
    application_name: "bcontext-worker",
    ssl: sslFor(connectionString),
    // The schema also ships as an unapplied SQL migration
    // (supabase/migrations/0060_pgboss_schema.sql). Leaving pg-boss's own
    // migrator enabled on the worker means a fresh environment self-heals
    // instead of crash-looping on a missing table.
    migrate: role === "worker",
    createSchema: role === "worker",
    supervise: role === "worker",
    schedule: role === "worker",
  });
}

/** Idempotently create every queue in the catalogue. */
export async function registerQueues(
  boss: Pick<PgBoss, "createQueue">,
  queues: readonly QueueDefinition[] = QUEUES,
): Promise<void> {
  for (const q of queues) {
    await boss.createQueue(q.name, q.options);
  }
}

/**
 * Reconcile the database's schedules against the catalogue: create/update the
 * ones declared here, and drop any left over from a previous deploy. This is
 * what makes the cadence versioned rather than a field in a web UI.
 */
export async function applySchedules(
  boss: Pick<PgBoss, "schedule" | "unschedule" | "getSchedules">,
  queues: readonly QueueDefinition[] = QUEUES,
): Promise<{ scheduled: string[]; removed: string[] }> {
  const wanted = queues.filter((q) => q.cron !== null);
  const scheduled: string[] = [];
  for (const q of wanted) {
    await boss.schedule(q.name, q.cron as string);
    scheduled.push(q.name);
  }
  const existing = await boss.getSchedules();
  const wantedNames = new Set(wanted.map((q) => q.name));
  const removed: string[] = [];
  for (const s of existing) {
    if (!wantedNames.has(s.name)) {
      await boss.unschedule(s.name);
      removed.push(s.name);
    }
  }
  return { scheduled, removed };
}

/** What pg-boss hands the handler. Read defensively: `batchSize: 1` means one
 *  element, but the identity fields are telemetry and a shape surprise from a
 *  library upgrade must not be able to fail a job. */
interface JobEnvelope {
  id?: string;
  name?: string;
  retryCount?: number;
  data?: unknown;
}

/**
 * Attach one worker per queue that has a handler.
 *
 * The wrapper around `handler()` is where a failed job enters the error
 * pipeline. Two properties matter and neither is negotiable:
 *
 *   - It re-throws, untouched. pg-boss decides retry, backoff and dead-letter
 *     from whether this promise rejects; a wrapper that swallowed in order to
 *     report would silently turn every retriable job into a successful no-op.
 *     Reporting happens *before* the `throw`, and the `throw` is the last
 *     statement.
 *   - The report cannot fail the job either. `reportWorkerError` never throws
 *     and never awaits, so the worst a broken collector costs is a report.
 *
 * `attempt` is the field that makes the panel readable here: three events from
 * the same job are one problem retrying, not three problems.
 */
export async function registerWorkers(
  boss: Pick<PgBoss, "work">,
  handlers: Record<string, (data?: Record<string, unknown>) => Promise<Record<string, unknown>>> = HANDLERS,
): Promise<string[]> {
  const ids: string[] = [];
  for (const [name, handler] of Object.entries(handlers)) {
    const id = await boss.work(
      name,
      { batchSize: 1, pollingIntervalSeconds: 5 },
      async (jobs: unknown) => {
        const started = Date.now();
        const job: JobEnvelope = (Array.isArray(jobs) ? jobs[0] : jobs) ?? {};
        try {
          const data =
            job.data && typeof job.data === "object" && !Array.isArray(job.data)
              ? (job.data as Record<string, unknown>)
              : undefined;
          const result = await handler(data);
          log.info("worker.job.done", {
            queue: name,
            duration_ms: Date.now() - started,
            ...result,
          });
          return result;
        } catch (err) {
          const durationMs = Date.now() - started;
          log.error("worker.job.failed", {
            queue: name,
            duration_ms: durationMs,
            error: {
              message: err instanceof Error ? err.message : String(err),
            },
          });
          reportWorkerError({
            operation: `job:${name}`,
            error: err,
            duration_ms: durationMs,
            job_id: typeof job.id === "string" ? job.id : undefined,
            job_name: typeof job.name === "string" ? job.name : name,
            attempt: typeof job.retryCount === "number" ? job.retryCount : undefined,
          });
          throw err;
        }
      },
    );
    ids.push(id);
  }
  return ids;
}

/**
 * Start (or return) the shared send-only instance for the request path.
 * The worker process builds its own with `createBoss("worker")`.
 */
export async function getBoss(): Promise<PgBoss> {
  if (instance) return instance;
  if (starting) return starting;
  starting = (async () => {
    const boss = createBoss("producer");
    boss.on("error", (err: unknown) => {
      log.error("worker.boss.error", {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
    });
    await boss.start();
    instance = boss;
    return boss;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}
