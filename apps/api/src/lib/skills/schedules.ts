/**
 * Skill schedules — the clock behind NEXO's proactivity.
 *
 * A row in `skill_schedules` says "run this, in this workspace, on this
 * cron, in this timezone". Two kinds today: the built-in `digest_weekly`
 * (no skill node; see `./digest`) and `skill`, which runs a skill node with
 * an empty input and publishes its output as a doc.
 *
 * Same shape as the connector cadence scheduler: every five minutes the
 * worker (`skills.schedule`) scans for enabled rows whose `next_run_at` is
 * due, advances `next_run_at` under a CAS — so two runners cannot both fire
 * — and enqueues one `skills.run-scheduled` job per row. A row with no
 * `next_run_at` yet gets one on the first pass and runs at the next slot,
 * never immediately. `runScheduledSkill` is the other half: load the row,
 * run it, stamp `last_run_at`.
 *
 * Nothing here is seeded; a schedule exists because an admin enabled it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "@bcontext-dev/contract/log";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getStorageById, type Storage } from "@/lib/storage";
import { enqueue } from "@/lib/queue/producers";
import { QUEUE_SKILLS_RUN_SCHEDULED } from "@/lib/queue/queues";
import { isValidCron, isValidTimezone, nextCronRun } from "./cron";
import { publishWeeklyDigest, type DigestDelivery } from "./digest";

export type ScheduleKind = "digest_weekly" | "skill";

/** Monday 09:00 in the schedule's timezone. */
export const DEFAULT_DIGEST_CRON = "0 9 * * 1";
const DEFAULT_DIGEST_TIMEZONE = "UTC";

export interface SkillSchedule {
  id: string;
  workspace_id: string;
  skill_id: string | null;
  kind: ScheduleKind;
  cron: string;
  timezone: string;
  enabled: boolean;
  delivery: DigestDelivery;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the REST surface reads and writes for the built-in digest. */
export interface DigestSettings {
  enabled: boolean;
  cron: string;
  timezone: string;
  delivery: { webhook: boolean; email: boolean };
  last_run_at: string | null;
  next_run_at: string | null;
}

export interface DigestSettingsPatch {
  enabled?: boolean;
  cron?: string;
  timezone?: string;
  delivery?: DigestDelivery;
}

export const DEFAULT_DIGEST_SETTINGS: DigestSettings = {
  enabled: false,
  cron: DEFAULT_DIGEST_CRON,
  timezone: DEFAULT_DIGEST_TIMEZONE,
  delivery: { webhook: false, email: false },
  last_run_at: null,
  next_run_at: null,
};

function deliveryOf(raw: unknown): DigestDelivery {
  const d = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { webhook: d.webhook === true, email: d.email === true };
}

function rowToSchedule(row: Record<string, unknown>): SkillSchedule {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    skill_id: typeof row.skill_id === "string" ? row.skill_id : null,
    kind: row.kind === "skill" ? "skill" : "digest_weekly",
    cron: typeof row.cron === "string" ? row.cron : DEFAULT_DIGEST_CRON,
    timezone: typeof row.timezone === "string" ? row.timezone : DEFAULT_DIGEST_TIMEZONE,
    enabled: row.enabled === true,
    delivery: deliveryOf(row.delivery),
    last_run_at: typeof row.last_run_at === "string" ? row.last_run_at : null,
    next_run_at: typeof row.next_run_at === "string" ? row.next_run_at : null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function settingsOf(schedule: SkillSchedule | null): DigestSettings {
  if (!schedule) return DEFAULT_DIGEST_SETTINGS;
  return {
    enabled: schedule.enabled,
    cron: schedule.cron,
    timezone: schedule.timezone,
    delivery: { webhook: schedule.delivery.webhook === true, email: schedule.delivery.email === true },
    last_run_at: schedule.last_run_at,
    next_run_at: schedule.next_run_at,
  };
}

/** Next slot strictly after `from`; null when the cron never fires. */
export function computeNextRun(schedule: Pick<SkillSchedule, "cron" | "timezone">, from: Date): Date | null {
  try {
    return nextCronRun(schedule.cron, schedule.timezone, from);
  } catch {
    return null;
  }
}

// -- Due scan (skills.schedule) ---------------------------------------------

export interface ScheduleScanResult {
  scanned: number;
  initialised: number;
  enqueued: number;
  skipped: number;
}

export async function scheduleDueSkills(
  admin: SupabaseClient = getSupabaseAdmin(),
  opts: { now?: Date; batchSize?: number } = {},
): Promise<ScheduleScanResult> {
  const now = opts.now ?? new Date();
  const result: ScheduleScanResult = { scanned: 0, initialised: 0, enqueued: 0, skipped: 0 };

  const { data, error } = await admin
    .from("skill_schedules")
    .select("*")
    .eq("enabled", true)
    .or(`next_run_at.is.null,next_run_at.lte.${now.toISOString()}`)
    .limit(opts.batchSize ?? 200);
  if (error) {
    log.warn("skills.scheduler.scan_failed", { error: { message: error.message } });
    return result;
  }

  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    result.scanned += 1;
    const row = rowToSchedule(raw);
    const next = computeNextRun(row, now);
    if (!next) {
      result.skipped += 1;
      continue;
    }

    if (!row.next_run_at) {
      // First pass after enabling: set the clock, run at the next slot.
      await admin
        .from("skill_schedules")
        .update({ next_run_at: next.toISOString() })
        .eq("id", row.id)
        .eq("workspace_id", row.workspace_id)
        .is("next_run_at", null);
      result.initialised += 1;
      continue;
    }

    // Advance first (CAS on the old value) so two runners cannot both fire.
    const advanced = await admin
      .from("skill_schedules")
      .update({ next_run_at: next.toISOString() })
      .eq("id", row.id)
      .eq("workspace_id", row.workspace_id)
      .eq("next_run_at", row.next_run_at)
      .select("id")
      .maybeSingle();
    if (!advanced.data) {
      result.skipped += 1;
      continue;
    }

    const jobId = await enqueue(
      QUEUE_SKILLS_RUN_SCHEDULED,
      { schedule_id: row.id, workspace_id: row.workspace_id, scheduled_for: row.next_run_at },
      { singletonKey: `${row.id}:${row.next_run_at}` },
    );
    if (!jobId) {
      // No queue runtime (no DATABASE_URL): run inline rather than lose the slot.
      await runScheduledSkill(admin, { schedule_id: row.id, workspace_id: row.workspace_id, scheduled_for: row.next_run_at });
    }
    result.enqueued += 1;
    log.info("skills.scheduler.enqueued", {
      schedule_id: row.id,
      workspace_id: row.workspace_id,
      kind: row.kind,
      next_run_at: next.toISOString(),
    });
  }
  return result;
}

// -- One run (skills.run-scheduled) -----------------------------------------

export interface RunScheduledInput {
  schedule_id: string;
  workspace_id?: string;
  scheduled_for?: string | null;
}

export interface RunScheduledResult {
  schedule_id: string;
  kind: ScheduleKind | null;
  workspace_id: string | null;
  node_id: string | null;
  status: "published" | "skipped";
  reason?: string;
}

export async function runScheduledSkill(
  admin: SupabaseClient = getSupabaseAdmin(),
  input: RunScheduledInput,
  deps: { resolveStorage?: (workspaceId: string) => Promise<Storage | null>; now?: Date } = {},
): Promise<RunScheduledResult> {
  const skip = (reason: string, extra: Partial<RunScheduledResult> = {}): RunScheduledResult => ({
    schedule_id: input.schedule_id,
    kind: null,
    workspace_id: input.workspace_id ?? null,
    node_id: null,
    status: "skipped",
    reason,
    ...extra,
  });
  if (!input.schedule_id) return skip("missing schedule_id");

  const { data, error } = await admin
    .from("skill_schedules")
    .select("*")
    .eq("id", input.schedule_id)
    .maybeSingle();
  if (error) throw new Error(`skills.run-scheduled: reading schedule failed: ${error.message}`);
  if (!data) return skip("schedule not found");
  const row = rowToSchedule(data as Record<string, unknown>);
  if (!row.enabled) return skip("disabled", { kind: row.kind, workspace_id: row.workspace_id });

  const resolve = deps.resolveStorage ?? getStorageById;
  const storage = await resolve(row.workspace_id);
  if (!storage) return skip("workspace not found", { kind: row.kind, workspace_id: row.workspace_id });

  const now = deps.now ?? new Date();
  let nodeId: string | null = null;
  if (row.kind === "digest_weekly") {
    const published = await publishWeeklyDigest(storage, { now, delivery: row.delivery, actorKind: "system" });
    nodeId = published.node.id;
  } else {
    nodeId = await runSkillToDoc(storage, row, now);
  }

  await admin
    .from("skill_schedules")
    .update({ last_run_at: now.toISOString() })
    .eq("id", row.id)
    .eq("workspace_id", row.workspace_id);

  return { schedule_id: row.id, kind: row.kind, workspace_id: row.workspace_id, node_id: nodeId, status: "published" };
}

/**
 * `kind = 'skill'`: run the skill node with an empty input and keep the
 * output as a dated doc. The digest is the one with a purpose-built
 * builder; this is the generic clock for any skill a workspace writes.
 */
async function runSkillToDoc(storage: Storage, row: SkillSchedule, now: Date): Promise<string | null> {
  if (!row.skill_id) return null;
  const { runSkill } = await import("./run");
  const skill = await storage.getNode(row.skill_id);
  if (!skill) return null;
  const result = await runSkill(storage, { skill_id: row.skill_id, input: {} });
  const node = await storage.createNode({
    title: `${skill.title} ${now.toISOString().slice(0, 10)}`,
    kind: "doc",
    parent_id: null,
    content_md: result.output,
    data: { source: "nexo.scheduled_skill", skill_id: row.skill_id, model: result.model_used, scheduled_at: now.toISOString() },
  });
  const { record } = await import("@/lib/activity");
  record(storage.workspace.slug, "create", node.id, node.title, `scheduled skill: ${skill.title}`, {
    actorKind: "system",
    payload: { via: "worker", node_kind: "doc", source: "nexo.scheduled_skill", skill_id: row.skill_id },
  });
  return node.id;
}

// -- Digest settings (REST) --------------------------------------------------

export async function getDigestSettings(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<DigestSettings> {
  const { data, error } = await admin
    .from("skill_schedules")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("kind", "digest_weekly")
    .is("skill_id", null)
    .maybeSingle();
  if (error) throw new Error(`digest settings: ${error.message}`);
  return settingsOf(data ? rowToSchedule(data as Record<string, unknown>) : null);
}

export class DigestSettingsError extends Error {
  constructor(message: string, public readonly field: "cron" | "timezone") {
    super(message);
    this.name = "DigestSettingsError";
  }
}

/**
 * Create or update the workspace's digest schedule. A change to the cron or
 * the timezone resets `next_run_at`, so the scheduler recomputes it on its
 * next pass instead of honouring a slot computed for the old clock.
 */
export async function upsertDigestSettings(
  admin: SupabaseClient,
  workspaceId: string,
  patch: DigestSettingsPatch,
  opts: { createdBy?: string | null; now?: Date } = {},
): Promise<DigestSettings> {
  if (patch.cron !== undefined && !isValidCron(patch.cron)) {
    throw new DigestSettingsError("cron must have five fields: minute hour day month weekday", "cron");
  }
  if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) {
    throw new DigestSettingsError("unknown IANA timezone", "timezone");
  }
  const current = await admin
    .from("skill_schedules")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("kind", "digest_weekly")
    .is("skill_id", null)
    .maybeSingle();
  if (current.error) throw new Error(`digest settings: ${current.error.message}`);
  const existing = current.data ? rowToSchedule(current.data as Record<string, unknown>) : null;

  const cron = patch.cron?.trim() ?? existing?.cron ?? DEFAULT_DIGEST_CRON;
  const timezone = patch.timezone?.trim() ?? existing?.timezone ?? DEFAULT_DIGEST_TIMEZONE;
  const enabled = patch.enabled ?? existing?.enabled ?? true;
  const delivery = {
    webhook: patch.delivery?.webhook ?? existing?.delivery.webhook ?? false,
    email: patch.delivery?.email ?? existing?.delivery.email ?? false,
  };
  const clockChanged = !existing || existing.cron !== cron || existing.timezone !== timezone || (!existing.enabled && enabled);
  const next_run_at = clockChanged && enabled
    ? computeNextRun({ cron, timezone }, opts.now ?? new Date())?.toISOString() ?? null
    : enabled ? existing?.next_run_at ?? null : null;

  const values = { workspace_id: workspaceId, skill_id: null, kind: "digest_weekly", cron, timezone, enabled, delivery, next_run_at };
  const written = existing
    ? await admin.from("skill_schedules").update(values).eq("id", existing.id).eq("workspace_id", workspaceId).select("*").single()
    : await admin.from("skill_schedules").insert({ ...values, created_by: opts.createdBy ?? null }).select("*").single();
  if (written.error || !written.data) {
    throw new Error(`digest settings: ${written.error?.message ?? "write failed"}`);
  }
  return settingsOf(rowToSchedule(written.data as Record<string, unknown>));
}

/** Emails of the workspace's owners and admins — the digest's recipients. */
export async function listWorkspaceAdminEmails(
  workspaceId: string,
  admin: SupabaseClient = getSupabaseAdmin(),
  limit = 20,
): Promise<string[]> {
  const { data, error } = await admin
    .from("memberships")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .in("role", ["owner", "admin"])
    .limit(limit);
  if (error || !data) return [];
  const emails = new Set<string>();
  for (const row of data as Array<{ user_id: string }>) {
    try {
      const { data: u } = await admin.auth.admin.getUserById(row.user_id);
      const email = u?.user?.email;
      if (email) emails.add(email.toLowerCase());
    } catch {
      // A user the auth server cannot resolve simply gets no mail.
    }
  }
  return [...emails];
}
