# Queue worker (pg-boss)

The queues are drained by a process of their own: the same image as the API
and the error collector, started with `BCONTEXT_PROCESS=worker`
(`node worker.js`). It is the only scheduler; there are no HTTP crons.

The cadence lives in [`src/lib/queue/queues.ts`](../../src/lib/queue/queues.ts),
versioned with the code; on every boot the worker reconciles the database
against that file (creates what is declared, removes what was dropped).

## What runs

| Queue | Cron | Domain code |
|---|---|---|
| `webhook.drain` | `* * * * *` (+ on demand) | `src/lib/webhooks/worker.ts` → `processDeliveries` |
| `connector.drain` | `* * * * *` | `src/lib/connectors/worker.ts` → `processConnectorJobs` |
| `connector.schedule` | `* * * * *` | `src/lib/connectors/scheduler.ts` → `scheduleDueSyncs` (queues a `full_sync` when `config.next_run_at` is due) |
| `capability.health-check` | `* * * * *` | `src/lib/capabilities/health-check.ts` → `runCapabilityHealthChecks` |
| `errors.retention` | `20 4 * * *` | `src/lib/errors/retention.ts` → `purgeErrorTelemetry` (`ERRORS_EVENT_RETENTION_DAYS`, `ERRORS_GROUP_RETENTION_DAYS`) |
| `tasks.auto-archive` | `40 4 * * *` | `src/lib/tasks/auto-archive.ts` → `archiveStaleDoneTasks` (tasks and bugs `done` and untouched for `TASKS_AUTO_ARCHIVE_DAYS`, default 30) |
| `nexo.contradictions` | `0 5 * * *` (+ on demand) | `src/lib/nexo/contradictions.ts` → `runContradictionScan` (compares recently edited H2 blocks with the nearest blocks of other nodes; a contradiction opens a `nexo_conflicts` row, never edits a node; capped by `NEXO_CONTRADICTIONS_MAX_PAIRS` model calls per workspace per day) |
| `skills.schedule` | `*/5 * * * *` | `src/lib/skills/schedules.ts` → `scheduleDueSkills` |
| `skills.run-scheduled` | on demand | `src/lib/skills/schedules.ts` → `runScheduledSkill` (e.g. the weekly digest) |
| `nexos.heartbeat` | `* * * * *` | `src/lib/nexos/triggers/heartbeat.ts` → `scheduleDueHeartbeats` (active hours in the Nexo's own time zone) |
| `nexos.run` | on demand | `src/lib/nexos/triggers/run-job.ts` → `runNexo` (one turn; at most one queued and one active per key) |
| `nexos.flush-windows` | `* * * * *` | `src/lib/nexos/triggers/flush.ts` → `flushDueWindows` (thread windows closed by silence, size or age: extract, triage, then one `batch` turn) |

On boot it logs `worker.boot.ready` with the registered queues and schedules.

## `DATABASE_URL`

pg-boss needs a direct, session-mode Postgres connection (not PostgREST, not
a transaction pooler). In the bundled `docker-compose.yml` it is
`postgresql://postgres:<POSTGRES_PASSWORD>@db:5432/postgres` with
`DATABASE_SSL=disable`.

The API takes the same variable: with it the API `LISTEN`s on the
`bcontext_realtime` channel the worker `NOTIFY`s on
(`src/lib/realtime/{publish,listener}.ts`), and webhook enqueueing becomes
transactional. Without it in the worker, broadcasts fall back to
`POST /realtime/broadcast` with `API_ORIGIN` and `REALTIME_SECRET`.

## pg-boss schema

pg-boss keeps its tables in the `pgboss` schema
([`0060_pgboss_schema.sql`](../../supabase/migrations/0060_pgboss_schema.sql),
generated verbatim from `require('pg-boss').getConstructionPlans('pgboss')`).
The worker also starts with `migrate: true`, so an empty database gets the
same schema; the migration exists to make it reviewable.

## Concurrency

Every drain claims its rows with a compare-and-set on `status`
(`.eq("status", row.status)`): the first runner wins the row, any other gets
zero rows. A second replica would therefore be harmless, but with per-minute
drains there is nothing to gain from one: run one worker.

## Transactional enqueueing

With `DATABASE_URL`, `emitEvent` (`src/lib/webhooks/dispatch.ts`) inserts the
`webhook_deliveries` rows and enqueues `webhook.drain` in the same
transaction (`boss.send(..., { db: tx })`): both commit or neither does.
Without it, rows go in through PostgREST and delivery is fire-and-forget
inside the request.

## Operating it

- **Activity**: the container logs (`docker compose logs -f worker`). Every
  run writes `worker.job.done`; failures `worker.job.failed`.
- **Retries**: 3 per job with exponential backoff (`queues.ts`); a job that
  exhausts them stays `failed` in `pgboss.job`.
- **Inspect**: `select name, state, count(*) from pgboss.job group by 1,2;`
- **Stop draining**: stop the container. Rows wait and are picked up on the
  next start.
- **Shutdown**: `SIGTERM` → `boss.stop({ graceful: true })`, in-flight batches
  get up to 30 s.
