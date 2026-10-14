/**
 * Job handlers — thin adapters, zero domain logic.
 *
 * Each handler is one call into a domain function (`processDeliveries`,
 * `processConnectorJobs`, `runCapabilityHealthChecks`, …) that owns the real
 * work. Those functions take a CAS lock on `status` per row, which is what
 * keeps a second worker replica harmless.
 *
 * Everything this file imports ends up in the worker bundle, so it must stay
 * free of request-only dependencies — `build:worker` fails on a violation.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { processDeliveries } from "@/lib/webhooks/worker";
import { processConnectorJobs } from "@/lib/connectors/worker";
import { scheduleDueSyncs } from "@/lib/connectors/scheduler";
import { runCapabilityHealthChecks } from "@/lib/capabilities/health-check";
import { expireAbandonedOAuthAttempts } from "@/lib/capabilities/oauth-expiry";
import { purgeErrorTelemetry } from "@/lib/errors/retention";
import { archiveStaleDoneTasks } from "@/lib/tasks/auto-archive";
import { runContradictionScan } from "@/lib/nexo/contradictions";
import { runScheduledSkill, scheduleDueSkills } from "@/lib/skills/schedules";
import { scheduleDueHeartbeats } from "@/lib/nexos/triggers/heartbeat";
import { flushDueWindows } from "@/lib/nexos/triggers/flush";
import { runNexoJob } from "@/lib/nexos/triggers/run-job";
import {
  QUEUE_CAPABILITY_HEALTH,
  QUEUE_CAPABILITY_OAUTH_EXPIRE,
  QUEUE_CONNECTOR_DRAIN,
  QUEUE_CONNECTOR_SCHEDULE,
  QUEUE_ERRORS_RETENTION,
  QUEUE_NEXO_CONTRADICTIONS,
  QUEUE_NEXOS_FLUSH_WINDOWS,
  QUEUE_NEXOS_HEARTBEAT,
  QUEUE_NEXOS_RUN,
  QUEUE_SKILLS_RUN_SCHEDULED,
  QUEUE_SKILLS_SCHEDULE,
  QUEUE_TASKS_AUTO_ARCHIVE,
  QUEUE_WEBHOOK_DRAIN,
} from "./queues";
import "@/lib/connectors/bootstrap";

/** `data` is the job payload; the scheduled drains carry none and ignore it. */
export type JobHandler = (data?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function str(data: Record<string, unknown> | undefined, key: string): string | null {
  const v = data?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export const HANDLERS: Record<string, JobHandler> = {
  [QUEUE_WEBHOOK_DRAIN]: async () => ({
    ...(await processDeliveries(getSupabaseAdmin())),
  }),
  [QUEUE_CONNECTOR_DRAIN]: async () => ({
    ...(await processConnectorJobs(getSupabaseAdmin())),
  }),
  [QUEUE_CONNECTOR_SCHEDULE]: async () => ({
    ...(await scheduleDueSyncs(getSupabaseAdmin())),
  }),
  [QUEUE_CAPABILITY_HEALTH]: async () => ({
    ...(await runCapabilityHealthChecks(getSupabaseAdmin())),
  }),
  [QUEUE_CAPABILITY_OAUTH_EXPIRE]: async () => ({
    ...(await expireAbandonedOAuthAttempts(getSupabaseAdmin())),
  }),
  // The only handler here that is not a drain: it deletes rather than
  // delivers, and it is what keeps the error tables bounded.
  [QUEUE_ERRORS_RETENTION]: async () => ({
    ...(await purgeErrorTelemetry()),
  }),
  // Housekeeping too: done for thirty quiet days → archived.
  [QUEUE_TASKS_AUTO_ARCHIVE]: async () => ({
    ...(await archiveStaleDoneTasks(getSupabaseAdmin())),
  }),
  // The daily sweep sends no payload; the on-change enqueue names one node.
  [QUEUE_NEXO_CONTRADICTIONS]: async (data) => ({
    ...(await runContradictionScan({
      nodeId: str(data, "node_id"),
      workspaceId: str(data, "workspace_id"),
    })),
  }),
  // NEXO proactivity: the clock (every five minutes) and the run it enqueues.
  [QUEUE_SKILLS_SCHEDULE]: async () => ({
    ...(await scheduleDueSkills(getSupabaseAdmin())),
  }),
  [QUEUE_SKILLS_RUN_SCHEDULED]: async (data) => ({
    ...(await runScheduledSkill(getSupabaseAdmin(), {
      schedule_id: str(data, "schedule_id") ?? "",
      workspace_id: str(data, "workspace_id") ?? undefined,
      scheduled_for: str(data, "scheduled_for"),
    })),
  }),
  // Nexos: the heartbeat clock, the window flush, and the turn both enqueue.
  [QUEUE_NEXOS_HEARTBEAT]: async () => ({ ...(await scheduleDueHeartbeats()) }),
  [QUEUE_NEXOS_FLUSH_WINDOWS]: async () => ({ ...(await flushDueWindows()) }),
  [QUEUE_NEXOS_RUN]: async (data) => ({ ...(await runNexoJob(data)) }),
};
