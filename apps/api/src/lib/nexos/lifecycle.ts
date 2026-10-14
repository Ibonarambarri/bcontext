/**
 * Creating, editing and deleting a Nexo as one consistent act: the `nexos`
 * row (`./store`) and its identity (`./principal`: agent row, workspace grant,
 * capability principal) always move together.
 *
 * Callers: the `/api/nexos` routes and `./general`. On the demo backend there
 * is no permission system to keep in step, so only the row is written and the
 * agent id is a fresh uuid.
 *
 * Must not break:
 *   - The general Nexo cannot be deleted (`NexoError` 409 `general_nexo`).
 *   - A brain-tools change resyncs the grant verbs in the same call; a rename
 *     renames the agent and the capability principal.
 *   - Deleting retires the identity BEFORE removing the row: if the second
 *     step fails the Nexo is still there but can do nothing, never the other
 *     way round.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_NEXO_BRAIN_TOOLS,
  type Nexo,
  type NexoAutonomy,
  type NexoBrainTools,
  type NexoEscalation,
  type NexoHeartbeat,
  type NexoQuestionnaire,
  type UpdateNexoBody,
} from "@bcontext-dev/contract/nexos";
import {
  createNexoPrincipal,
  discardNexoPrincipal,
  resolveNexoOwner,
  retireNexoPrincipal,
  syncNexoPrincipal,
} from "./principal";
import { deleteNexoRow, getNexo, insertNexoRow, uniqueNexoSlug, updateNexoRow } from "./store";
import { defaultsFor, type NexoCreationOptions } from "./templates";
import type { NexoRowPatch, NexoTarget } from "./types";

/** A refusal the routes turn into a status code. */
export class NexoError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "NexoError";
  }
}

export interface CreateNexoInput {
  name: string;
  description?: string;
  template: string;
  questionnaire: NexoQuestionnaire;
  prompt_md: string;
  autonomy?: NexoAutonomy;
  brain_tools?: NexoBrainTools;
  heartbeat?: NexoHeartbeat;
  escalation?: NexoEscalation;
  /** Request-level heartbeat overrides and escalation recipient (see `defaultsFor`). */
  creation?: NexoCreationOptions;
  model?: string | null;
  isGeneral?: boolean;
  /** The person creating it; null for lazily-created rows (owner falls back to the workspace owner). */
  createdBy: string | null;
}

/** Create the row and its identity. */
export async function createNexo(t: NexoTarget, input: CreateNexoInput): Promise<Nexo> {
  const defaults = defaultsFor(input.template, input.questionnaire, input.creation);
  const brainTools = input.brain_tools ?? defaults.brain_tools ?? DEFAULT_NEXO_BRAIN_TOOLS;
  const name = input.name.trim().slice(0, 80);
  const description = (input.description ?? "").trim().slice(0, 500);
  const slug = await uniqueNexoSlug(t, name);

  const agentId = t.backend === "supabase"
    ? await createNexoPrincipal({
        workspaceId: t.workspaceId,
        ownerUserId: await resolveNexoOwner(t.workspaceId, input.createdBy),
        name,
        description,
        brainTools,
      })
    : randomUUID();

  try {
    return await insertNexoRow(t, {
      agent_id: agentId,
      slug,
      name,
      description,
      is_general: input.isGeneral === true,
      template: input.template,
      questionnaire: input.questionnaire,
      prompt_md: input.prompt_md,
      model: input.model ?? null,
      autonomy: input.autonomy ?? defaults.autonomy,
      brain_tools: brainTools,
      heartbeat: input.heartbeat ?? defaults.heartbeat,
      escalation: input.escalation ?? defaults.escalation,
      monthly_budget_credits: null,
      created_by: input.createdBy,
    });
  } catch (err) {
    if (t.backend === "supabase") await discardNexoPrincipal(t.workspaceId, agentId).catch(() => {});
    throw err;
  }
}

/**
 * Apply a PATCH. Keeps the identity in step (name, description, brain tools)
 * and keeps the heartbeat schedule honest: turning it off clears
 * `next_heartbeat_at`, turning it on (or changing the cadence) asks the
 * trigger to schedule it from scratch by clearing it too — the heartbeat
 * trigger owns the clock and knows the active hours.
 */
export async function updateNexo(t: NexoTarget, nexo: Nexo, patch: UpdateNexoBody): Promise<Nexo> {
  const row: NexoRowPatch = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.description !== undefined) row.description = patch.description.trim();
  if (patch.prompt_md !== undefined) row.prompt_md = patch.prompt_md;
  if (patch.questionnaire !== undefined) row.questionnaire = patch.questionnaire;
  if (patch.autonomy !== undefined) row.autonomy = patch.autonomy;
  if (patch.brain_tools !== undefined) row.brain_tools = patch.brain_tools;
  if (patch.escalation !== undefined) row.escalation = patch.escalation;
  if (patch.monthly_budget_credits !== undefined) row.monthly_budget_credits = patch.monthly_budget_credits;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.model !== undefined) row.model = patch.model;
  if (patch.heartbeat !== undefined) {
    row.heartbeat = patch.heartbeat;
    const cadenceChanged =
      patch.heartbeat.enabled !== nexo.heartbeat.enabled ||
      patch.heartbeat.every_minutes !== nexo.heartbeat.every_minutes ||
      JSON.stringify(patch.heartbeat.active_hours) !== JSON.stringify(nexo.heartbeat.active_hours);
    if (cadenceChanged) row.next_heartbeat_at = null;
  }
  if (Object.keys(row).length === 0) return nexo;

  if (t.backend === "supabase") {
    const renamed = row.name !== undefined && row.name !== nexo.name;
    const redescribed = row.description !== undefined && row.description !== nexo.description;
    const toolsChanged =
      row.brain_tools !== undefined &&
      (row.brain_tools.read !== nexo.brain_tools.read || row.brain_tools.write !== nexo.brain_tools.write);
    if (renamed || redescribed || toolsChanged) {
      await syncNexoPrincipal({
        workspaceId: t.workspaceId,
        agentId: nexo.agent_id,
        name: renamed ? row.name : undefined,
        description: redescribed ? row.description : undefined,
        brainTools: toolsChanged ? row.brain_tools : undefined,
      });
    }
  }

  const updated = await updateNexoRow(t, nexo.id, row);
  if (!updated) throw new NexoError(404, "nexo_not_found");
  return updated;
}

/** Delete a specialist. The general Nexo answers 409. */
export async function deleteNexo(t: NexoTarget, nexoId: string): Promise<Nexo> {
  const nexo = await getNexo(t, nexoId);
  if (!nexo) throw new NexoError(404, "nexo_not_found");
  if (nexo.is_general) {
    throw new NexoError(409, "general_nexo", "The general Nexo cannot be deleted; pause it instead.");
  }
  if (t.backend === "supabase") await retireNexoPrincipal(t.workspaceId, nexo.agent_id);
  await deleteNexoRow(t, nexo.id);
  return nexo;
}
