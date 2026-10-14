/**
 * Queue catalogue — the single versioned declaration of what the worker runs
 * and when.
 *
 * The cadence lives here, in the repo — not in a hosting panel — and
 * `applySchedules()` reconciles the database against it on every worker boot,
 * including removing schedules that were dropped from this file. Ops view in
 * `docs/ops/worker.md`.
 */
import type { Queue, QueueOptions } from "pg-boss";

export const QUEUE_WEBHOOK_DRAIN = "webhook.drain";
export const QUEUE_CONNECTOR_DRAIN = "connector.drain";
export const QUEUE_CAPABILITY_HEALTH = "capability.health-check";
export const QUEUE_CAPABILITY_OAUTH_EXPIRE = "capability.oauth-expire";
export const QUEUE_ERRORS_RETENTION = "errors.retention";
export const QUEUE_CONNECTOR_SCHEDULE = "connector.schedule";
export const QUEUE_TASKS_AUTO_ARCHIVE = "tasks.auto-archive";
export const QUEUE_NEXO_CONTRADICTIONS = "nexo.contradictions";
export const QUEUE_SKILLS_SCHEDULE = "skills.schedule";
export const QUEUE_SKILLS_RUN_SCHEDULED = "skills.run-scheduled";
export const QUEUE_NEXOS_HEARTBEAT = "nexos.heartbeat";
export const QUEUE_NEXOS_RUN = "nexos.run";
export const QUEUE_NEXOS_FLUSH_WINDOWS = "nexos.flush-windows";

export interface QueueDefinition {
  name: string;
  /** pg-boss queue policy/retry settings (`policy` only matters at creation). */
  options: QueueOptions & Pick<Queue, "policy">;
  /** Cron expression, or null for on-demand-only queues. */
  cron: string | null;
  /** One-line description, mirrored into the ops runbook. */
  description: string;
}

/**
 * Every queue is `singleton`-shaped in spirit: the drains are idempotent and
 * guarded by a CAS lock in the domain code, but running one at a time keeps
 * the connection budget flat and the logs readable.
 */
const DRAIN_OPTIONS: QueueOptions = {
  // A batch can legitimately take a while (25 HTTP posts × 5s timeout).
  expireInSeconds: 300,
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  // A tick that never ran is worthless an hour later; the next one covers it.
  retentionSeconds: 3600,
  deleteAfterSeconds: 86_400,
};

export const QUEUES: readonly QueueDefinition[] = [
  {
    name: QUEUE_WEBHOOK_DRAIN,
    options: DRAIN_OPTIONS,
    cron: "* * * * *",
    description:
      "Drains due webhook_deliveries rows (src/lib/webhooks/worker.ts).",
  },
  {
    name: QUEUE_CONNECTOR_DRAIN,
    options: DRAIN_OPTIONS,
    cron: "* * * * *",
    description:
      "Drains due connector_jobs rows (src/lib/connectors/worker.ts).",
  },
  {
    name: QUEUE_CONNECTOR_SCHEDULE,
    options: DRAIN_OPTIONS,
    cron: "* * * * *",
    description:
      "Enqueues a full_sync for every active install whose cadence is due (src/lib/connectors/scheduler.ts).",
  },
  {
    name: QUEUE_CAPABILITY_HEALTH,
    options: { ...DRAIN_OPTIONS, expireInSeconds: 900 },
    cron: "* * * * *",
    description:
      "Pings approved executable capabilities (src/lib/capabilities/health-check.ts).",
  },
  {
    name: QUEUE_CAPABILITY_OAUTH_EXPIRE,
    // Was a pg_cron job (migration 0034, removed by 0097) on the same
    // five-minute clock. Idempotent and row-locked in SQL, so a duplicate
    // tick from a second replica is harmless.
    options: DRAIN_OPTIONS,
    cron: "*/5 * * * *",
    description:
      "Expires abandoned capability OAuth attempts and deletes their Vault material (src/lib/capabilities/oauth-expiry.ts).",
  },
  {
    name: QUEUE_ERRORS_RETENTION,
    // Nothing like the drains: this runs once a day, takes as long as it
    // takes, and a tick that was missed is genuinely covered by the next one
    // — the predicate is "older than N days", not "since the last run", so
    // the job is idempotent and skipping one costs a day of extra rows.
    options: {
      expireInSeconds: 600,
      retryLimit: 2,
      retryDelay: 300,
      retryBackoff: true,
      retentionSeconds: 86_400,
      deleteAfterSeconds: 604_800,
    },
    // 04:20 UTC: the quietest hour, and offset from the round numbers every
    // other scheduler on the box reaches for.
    cron: "20 4 * * *",
    description:
      "Deletes error_events past their retention and the empty, unannotated error_groups left behind (src/lib/errors/retention.ts).",
  },
  {
    name: QUEUE_TASKS_AUTO_ARCHIVE,
    // Same shape as the retention purge: daily, idempotent ("done and
    // untouched for N days"), a missed tick is covered by the next one.
    options: {
      expireInSeconds: 600,
      retryLimit: 2,
      retryDelay: 300,
      retryBackoff: true,
      retentionSeconds: 86_400,
      deleteAfterSeconds: 604_800,
    },
    // 04:40 UTC, twenty minutes after the purge so the two never overlap.
    cron: "40 4 * * *",
    description:
      "Archives tasks and bugs that have been done and untouched for TASKS_AUTO_ARCHIVE_DAYS (30) days (src/lib/tasks/auto-archive.ts).",
  },
  {
    name: QUEUE_NEXO_CONTRADICTIONS,
    // Daily sweep of the docs/decisions/ADRs edited in the last day, and
    // on-demand per node after a write (singleton per node, short delay).
    // Model calls cost money: one retry, and the per-workspace daily cap
    // (NEXO_CONTRADICTIONS_MAX_PAIRS) is what bounds the bill, not this.
    options: {
      expireInSeconds: 900,
      retryLimit: 1,
      retryDelay: 300,
      retryBackoff: true,
      retentionSeconds: 86_400,
      deleteAfterSeconds: 604_800,
    },
    // 05:00 UTC, after the housekeeping jobs; a node's on-change scans run
    // whenever they are due.
    cron: "0 5 * * *",
    description:
      "Compares recently edited docs/decisions/ADRs with their closest blocks elsewhere and opens a contradiction conflict with citations to both (src/lib/nexo/contradictions.ts).",
  },
  {
    name: QUEUE_SKILLS_SCHEDULE,
    options: DRAIN_OPTIONS,
    // Five minutes is the resolution of a skill schedule: a digest due at
    // 09:00 runs by 09:05. Finer than that buys nothing for a weekly job.
    cron: "*/5 * * * *",
    description:
      "Enqueues a skills.run-scheduled job for every enabled skill_schedules row whose next_run_at is due, advancing the clock under a CAS (src/lib/skills/schedules.ts).",
  },
  {
    name: QUEUE_SKILLS_RUN_SCHEDULED,
    // One schedule per job, carried in the job data. A digest reads a week
    // of feed and may call the model; give it room.
    options: { ...DRAIN_OPTIONS, expireInSeconds: 900 },
    cron: null,
    description:
      "Runs one scheduled skill: the built-in weekly digest (src/lib/skills/digest.ts) or a skill node, then stamps last_run_at (src/lib/skills/schedules.ts).",
  },
  {
    name: QUEUE_NEXOS_HEARTBEAT,
    // The clock only: it reads due rows and enqueues runs, advancing each
    // Nexo's next_heartbeat_at under a CAS, so a duplicate tick is harmless.
    options: DRAIN_OPTIONS,
    cron: "* * * * *",
    description:
      "Enqueues a nexos.run (trigger heartbeat) for every active Nexo whose heartbeat is due inside its active hours, and schedules the next beat (src/lib/nexos/triggers/heartbeat.ts).",
  },
  {
    name: QUEUE_NEXOS_RUN,
    // One Nexo turn per job (model + tools). `stately` with a singletonKey per
    // Nexo and source keeps at most one queued and one active job per key: a
    // burst of mentions collapses into one queued turn, and a message that
    // lands while a turn is running still gets the next one. One retry: a
    // turn costs money and a failed one is recorded as a failed run.
    options: {
      policy: "stately",
      expireInSeconds: 600,
      retryLimit: 1,
      retryDelay: 60,
      retryBackoff: true,
      retentionSeconds: 3600,
      deleteAfterSeconds: 604_800,
    },
    cron: null,
    description:
      "Runs one Nexo turn (heartbeat, event, batch or manual) through the headless runner (src/lib/nexos/triggers/run-job.ts → src/lib/nexos/runtime/runner.ts).",
  },
  {
    name: QUEUE_NEXOS_FLUSH_WINDOWS,
    // Claims due message windows (atomic RPC) and flushes each: one batch
    // extraction pass, then one Nexo turn over the block. A crashed flush is
    // reclaimed after WINDOW_DEFAULTS.staleSeconds, so a retry is safe.
    options: { ...DRAIN_OPTIONS, expireInSeconds: 900 },
    cron: "* * * * *",
    description:
      "Flushes due Nexo message windows: batch extraction → ingest candidates → triage attributed to the Nexo, then a batch turn to reply or escalate (src/lib/nexos/triggers/flush.ts).",
  },
] as const;

export function queueByName(name: string): QueueDefinition | undefined {
  return QUEUES.find((q) => q.name === name);
}
