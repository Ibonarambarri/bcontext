/**
 * The general Nexo: one per workspace, always present, never deleted. It is
 * the assistant every workspace already had (`/api/nexo` keeps answering as
 * it) and the owner of every inbound event no specialist's binding claims.
 *
 * Created lazily rather than backfilled: the first `GET /api/nexos` (or a
 * runtime/routing lookup) calls `ensureGeneralNexo`, which creates it with its
 * agent row and grant through `./lifecycle`. Concurrent first calls are safe —
 * the partial unique index `nexos_one_general` lets exactly one insert win and
 * the loser re-reads the winner's row.
 */
import { renderNexoPrompt, type Nexo } from "@bcontext-dev/contract/nexos";
import { createNexo } from "./lifecycle";
import { getGeneralNexo, NexoConflictError } from "./store";
import { GENERAL_NEXO } from "./templates";
import type { NexoTarget } from "./types";

/**
 * The workspace's general Nexo, creating it if missing. `createdBy` becomes
 * the agent owner when the row is created; with null the workspace owner is
 * used (an agent token or the worker can trigger creation too).
 */
export async function ensureGeneralNexo(
  t: NexoTarget,
  opts: { createdBy?: string | null } = {},
): Promise<Nexo> {
  const existing = await getGeneralNexo(t);
  if (existing) return existing;
  try {
    return await createNexo(t, {
      name: GENERAL_NEXO.name,
      description: GENERAL_NEXO.description,
      template: GENERAL_NEXO.template,
      questionnaire: GENERAL_NEXO.questionnaire,
      prompt_md: renderNexoPrompt(GENERAL_NEXO.questionnaire),
      autonomy: GENERAL_NEXO.autonomy,
      brain_tools: GENERAL_NEXO.brain_tools,
      isGeneral: true,
      createdBy: opts.createdBy ?? null,
    });
  } catch (err) {
    // Lost the race to another first caller: theirs is the general Nexo.
    if (err instanceof NexoConflictError) {
      const winner = await getGeneralNexo(t);
      if (winner) return winner;
    }
    throw err;
  }
}
