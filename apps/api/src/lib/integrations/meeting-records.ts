/**
 * Meeting records — mandatory integration setup.
 *
 * The recorder itself (Recall.ai bot, webhook, transcript node) already
 * works; this module adds the configuration gate: the integration stays
 * semi-locked in the Integrations surface until the workspace saves
 *   - a processing cadence (forced to "instant" for meeting records —
 *     recordings are processed the moment they arrive; the field exists
 *     because future integrations will offer configurable cadences),
 *   - a free-text objective ("what should we extract for you?"),
 *   - the accepted extraction items generated from that objective.
 *
 * Persistence: `connector_installs.config` under connector_id
 * 'meeting-bot' — the same bag every other connector uses for its ingest
 * goal/cadence. The check constraint on connector_id learns the
 * 'meeting-bot' value in migration 0053 (NOT applied automatically); until
 * it is applied on deploy, Supabase writes fail with 23514 and the API
 * degrades with a clear "migration pending" error. Demo workspaces keep
 * the config in-memory so the flow is fully usable without Supabase.
 */
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const MEETING_RECORDS_CONNECTOR_ID = "meeting-bot";

export const ExtractionItemSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(80),
  detail: z.string().max(240).default(""),
});

const MeetingRecordsConfigSchema = z.object({
  /** Forced value — kept in the shape so future cadences deserialize. */
  cadence: z.literal("instant"),
  objective: z.string().min(12).max(2000),
  extraction_items: z.array(ExtractionItemSchema).min(1).max(12),
  configured_at: z.string(),
});

export type MeetingRecordsConfig = z.infer<typeof MeetingRecordsConfigSchema>;

export class MeetingRecordsMigrationPendingError extends Error {
  constructor() {
    super(
      "Saving this configuration requires migration 0053_integration_requests.sql to be applied.",
    );
    this.name = "MeetingRecordsMigrationPendingError";
  }
}

/** In-memory fallback for demo (non-Supabase) workspaces, keyed by ws id. */
const demoConfigs = new Map<string, MeetingRecordsConfig>();

export async function getMeetingRecordsConfig(
  backend: "supabase" | "demo",
  workspaceId: string,
): Promise<MeetingRecordsConfig | null> {
  if (backend !== "supabase") {
    return demoConfigs.get(workspaceId) ?? null;
  }
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("connector_installs")
    .select("config, status")
    .eq("workspace_id", workspaceId)
    .eq("connector_id", MEETING_RECORDS_CONNECTOR_ID)
    .maybeSingle();
  if (error || !data || data.status === "uninstalled") return null;
  const parsed = MeetingRecordsConfigSchema.safeParse(
    (data.config as Record<string, unknown> | null)?.meeting_records,
  );
  return parsed.success ? parsed.data : null;
}

export async function saveMeetingRecordsConfig(
  backend: "supabase" | "demo",
  workspaceId: string,
  config: MeetingRecordsConfig,
): Promise<void> {
  if (backend !== "supabase") {
    demoConfigs.set(workspaceId, config);
    return;
  }
  const sb = getSupabaseAdmin();
  const { data: existing } = await sb
    .from("connector_installs")
    .select("id, config")
    .eq("workspace_id", workspaceId)
    .eq("connector_id", MEETING_RECORDS_CONNECTOR_ID)
    .maybeSingle();

  if (existing) {
    const merged = {
      ...(existing.config as Record<string, unknown>),
      meeting_records: config,
      // Mirrored at the top level so the Integrations queue page's generic
      // goal/cadence readers see the same values as other connectors.
      ingest_guidance: config.objective,
      cadence: { mode: "instant" },
    };
    const { error } = await sb
      .from("connector_installs")
      .update({ config: merged, status: "active", updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) throw toSaveError(error);
    return;
  }

  const { error } = await sb.from("connector_installs").insert({
    workspace_id: workspaceId,
    connector_id: MEETING_RECORDS_CONNECTOR_ID,
    config: {
      meeting_records: config,
      ingest_guidance: config.objective,
      cadence: { mode: "instant" },
    },
    status: "active",
  });
  if (error) throw toSaveError(error);
}

function toSaveError(error: { code?: string; message?: string }): Error {
  // 23514 = check_violation: connector_id doesn't allow 'meeting-bot'
  // yet because migration 0053 hasn't been applied to this database.
  if (error.code === "23514" || /connector_id/.test(error.message ?? "")) {
    return new MeetingRecordsMigrationPendingError();
  }
  return new Error(error.message ?? "failed to save meeting records config");
}
