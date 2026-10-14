/**
 * The handlers must stay adapters: one domain call each, nothing else.
 * Domain logic lives in `src/lib/{webhooks,connectors,capabilities}`, never
 * here.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: { marker: "admin" },
  processDeliveries: vi.fn(async () => ({ picked: 1, sent: 1, retried: 0, dead: 0 })),
  processConnectorJobs: vi.fn(async () => ({ picked: 2, done: 2, failed: 0, dead: 0 })),
  runCapabilityHealthChecks: vi.fn(async () => ({ checked: 3 })),
  expireAbandonedOAuthAttempts: vi.fn(async () => ({ expired: 2, batches: 1 })),
  purgeErrorTelemetry: vi.fn(async () => ({ events_deleted: 4, groups_deleted: 1 })),
  archiveStaleDoneTasks: vi.fn(async () => ({ days: 30, scanned: 2, archived: 2, skipped: 0 })),
  runContradictionScan: vi.fn(async () => ({ nodes: 1, blocks: 2, candidates: 3, judged: 3, opened: 1, capped: 0, workspaces: 1 })),
  scheduleDueSkills: vi.fn(async () => ({ scanned: 1, initialised: 0, enqueued: 1, skipped: 0 })),
  runScheduledSkill: vi.fn(async () => ({ schedule_id: "s1", kind: "digest_weekly", workspace_id: "ws-1", node_id: "n1", status: "published" })),
}));
const {
  admin,
  processDeliveries,
  processConnectorJobs,
  runCapabilityHealthChecks,
  purgeErrorTelemetry,
} = mocks;

vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => mocks.admin }));
vi.mock("@/lib/webhooks/worker", () => ({ processDeliveries: mocks.processDeliveries }));
vi.mock("@/lib/connectors/worker", () => ({ processConnectorJobs: mocks.processConnectorJobs }));
vi.mock("@/lib/capabilities/health-check", () => ({
  runCapabilityHealthChecks: mocks.runCapabilityHealthChecks,
}));
vi.mock("@/lib/capabilities/oauth-expiry", () => ({
  expireAbandonedOAuthAttempts: mocks.expireAbandonedOAuthAttempts,
}));
vi.mock("@/lib/errors/retention", () => ({
  purgeErrorTelemetry: mocks.purgeErrorTelemetry,
}));
vi.mock("@/lib/tasks/auto-archive", () => ({
  archiveStaleDoneTasks: mocks.archiveStaleDoneTasks,
}));
vi.mock("@/lib/nexo/contradictions", () => ({
  runContradictionScan: mocks.runContradictionScan,
}));
vi.mock("@/lib/skills/schedules", () => ({
  scheduleDueSkills: mocks.scheduleDueSkills,
  runScheduledSkill: mocks.runScheduledSkill,
}));
vi.mock("@/lib/connectors/bootstrap", () => ({}));

import { HANDLERS } from "./handlers";
import {
  QUEUES,
  QUEUE_CAPABILITY_HEALTH,
  QUEUE_CAPABILITY_OAUTH_EXPIRE,
  QUEUE_CONNECTOR_DRAIN,
  QUEUE_ERRORS_RETENTION,
  QUEUE_NEXO_CONTRADICTIONS,
  QUEUE_SKILLS_RUN_SCHEDULED,
  QUEUE_SKILLS_SCHEDULE,
  QUEUE_TASKS_AUTO_ARCHIVE,
  QUEUE_WEBHOOK_DRAIN,
} from "./queues";

describe("job handlers", () => {
  it("archives stale done tasks with the service-role client", async () => {
    await expect(HANDLERS[QUEUE_TASKS_AUTO_ARCHIVE]!()).resolves.toEqual({ days: 30, scanned: 2, archived: 2, skipped: 0 });
    expect(mocks.archiveStaleDoneTasks).toHaveBeenCalledWith(admin);
  });

  it("scans for contradictions: the whole day without a payload, one node with it", async () => {
    await expect(HANDLERS[QUEUE_NEXO_CONTRADICTIONS]!()).resolves.toMatchObject({ opened: 1 });
    expect(mocks.runContradictionScan).toHaveBeenLastCalledWith({ nodeId: null, workspaceId: null });
    await HANDLERS[QUEUE_NEXO_CONTRADICTIONS]!({ node_id: "n1", workspace_id: "ws" });
    expect(mocks.runContradictionScan).toHaveBeenLastCalledWith({ nodeId: "n1", workspaceId: "ws" });
  });

  // Asserted against the catalogue rather than a list repeated here: a queue
  // added without a handler is scheduled, fires, and finds nothing to run —
  // which looks exactly like a queue that is working.
  it("covers every queue in the catalogue", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(QUEUES.map((q) => q.name).sort());
  });

  it("drains webhooks with the service-role client", async () => {
    await expect(HANDLERS[QUEUE_WEBHOOK_DRAIN]!()).resolves.toEqual({
      picked: 1,
      sent: 1,
      retried: 0,
      dead: 0,
    });
    expect(processDeliveries).toHaveBeenCalledWith(admin);
  });

  it("drains connector jobs", async () => {
    await expect(HANDLERS[QUEUE_CONNECTOR_DRAIN]!()).resolves.toMatchObject({ picked: 2 });
    expect(processConnectorJobs).toHaveBeenCalledWith(admin);
  });

  it("runs capability health checks", async () => {
    await expect(HANDLERS[QUEUE_CAPABILITY_HEALTH]!()).resolves.toEqual({ checked: 3 });
    expect(runCapabilityHealthChecks).toHaveBeenCalledWith(admin);
  });

  it("expires abandoned capability OAuth attempts", async () => {
    await expect(HANDLERS[QUEUE_CAPABILITY_OAUTH_EXPIRE]!()).resolves.toEqual({ expired: 2, batches: 1 });
    expect(mocks.expireAbandonedOAuthAttempts).toHaveBeenCalledWith(admin);
  });

  it("scans skill schedules with the service-role client", async () => {
    await expect(HANDLERS[QUEUE_SKILLS_SCHEDULE]!()).resolves.toEqual({ scanned: 1, initialised: 0, enqueued: 1, skipped: 0 });
    expect(mocks.scheduleDueSkills).toHaveBeenCalledWith(admin);
  });

  // The one handler addressed by its job data: the schedule id travels in the
  // payload, and a payload of the wrong shape becomes an empty id the domain
  // function reports as skipped — never a throw from the adapter.
  it("runs the scheduled skill named by the job data", async () => {
    await expect(
      HANDLERS[QUEUE_SKILLS_RUN_SCHEDULED]!({ schedule_id: "s1", workspace_id: "ws-1", scheduled_for: "2026-09-14T09:00:00.000Z" }),
    ).resolves.toMatchObject({ schedule_id: "s1", status: "published" });
    expect(mocks.runScheduledSkill).toHaveBeenCalledWith(admin, {
      schedule_id: "s1",
      workspace_id: "ws-1",
      scheduled_for: "2026-09-14T09:00:00.000Z",
    });
    await HANDLERS[QUEUE_SKILLS_RUN_SCHEDULED]!({ schedule_id: 42 });
    expect(mocks.runScheduledSkill).toHaveBeenLastCalledWith(admin, { schedule_id: "", workspace_id: undefined, scheduled_for: null });
  });

  it("purges the error tables", async () => {
    await expect(HANDLERS[QUEUE_ERRORS_RETENTION]!()).resolves.toEqual({
      events_deleted: 4,
      groups_deleted: 1,
    });
    expect(purgeErrorTelemetry).toHaveBeenCalled();
  });
});
