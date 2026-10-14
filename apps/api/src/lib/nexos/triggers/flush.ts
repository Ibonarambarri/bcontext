/**
 * Window flush: the moment a Nexo digests a conversation. Every minute
 * (`nexos.flush-windows`) the due windows are claimed atomically and each is
 * processed as ONE block:
 *
 *   1. ingestion — one batch-extraction pass over the block through the
 *      existing pipeline (`extractBatch` → `proposeCandidate` →
 *      `triageCandidate`), the same one the Nango drain uses, with the Nexo
 *      in the provenance and the model call billed to the `nexo` surface.
 *      Only for windows of a binding: a bound channel's legacy per-message
 *      capture is skipped (see `./slack-inbound`), so this IS its ingestion.
 *      The general Nexo's fallback windows skip it — the legacy path already
 *      ingests those channels and doing it twice would duplicate the brain.
 *   2. a `batch` turn of the Nexo over the block, which decides whether to
 *      reply, draft or escalate (the runner owns autonomy).
 *   3. `markWindowFlushed`.
 *
 * Callers: the `nexos.flush-windows` job (`src/lib/queue/handlers.ts`).
 *
 * Must not break — idempotent on retries:
 *   - Each message is its own signal keyed `<source_key>:<ts>`, so a
 *     re-extracted window proposes candidates with the same external ids and
 *     `proposeCandidate` refreshes or no-ops instead of duplicating; a later
 *     window of the same thread has new ids.
 *   - A window whose worker died stays `flushing` and is reclaimed by the
 *     claim RPC after `WINDOW_DEFAULTS.staleSeconds`. An extraction failure
 *     leaves it there on purpose (retry later) unless the window is older
 *     than `GIVE_UP_AFTER_MS`, so a poison window cannot loop forever.
 *   - A failed turn is recorded by the runner and does not block the flush:
 *     turns cost money, the block is never replayed for them.
 *   - The extraction is billed to the Nexo (`metadata.nexo_id`), so a Nexo
 *     over its monthly budget skips it like it skips its runs; otherwise a
 *     busy channel keeps spending on a Nexo whose owner capped it.
 */
import { log } from "@bcontext-dev/contract/log";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import type { StorageBackend } from "@/lib/storage";
import { batchExternalId, extractBatch, type IngestSignal } from "@/lib/ingest/batch-extract";
import { ExtractCandidateError } from "@/lib/ingest/extract";
import { proposeCandidate } from "@/lib/ingest/candidates";
import { triageCandidate } from "@/lib/nexo/triage";
import { checkNexoBudget } from "../runtime/budget";
import { runNexo, type RunNexoInput } from "../runtime/runner";
import { claimDueWindows, getNexoById, markWindowFlushed } from "../store";
import type { Nexo, NexoTarget, NexoWindow } from "../types";

/** A window still failing extraction this long after its last message is flushed anyway. */
export const GIVE_UP_AFTER_MS = 6 * 60 * 60_000;

// Late-bound so a test that mocks one of these modules piecemeal can still
// import this file.
const realDeps = () => ({
  extractBatch: (...a: Parameters<typeof extractBatch>) => extractBatch(...a),
  proposeCandidate: (...a: Parameters<typeof proposeCandidate>) => proposeCandidate(...a),
  triageCandidate: (...a: Parameters<typeof triageCandidate>) => triageCandidate(...a),
  runNexo: (...a: Parameters<typeof runNexo>) => runNexo(...a),
  checkNexoBudget: (...a: Parameters<typeof checkNexoBudget>) => checkNexoBudget(...a),
});
const deps = realDeps();

/** Test seam: replace the pipeline and the runner. `null` restores them. */
export function setFlushDepsForTests(patch: Partial<typeof deps> | null): void {
  Object.assign(deps, patch ?? realDeps());
}

export interface FlushResult {
  claimed: number;
  flushed: number;
  candidates: number;
  accepted: number;
  turns: number;
  deferred: number;
  failed: number;
}

export async function flushDueWindows(
  opts: { now?: Date; limit?: number; backend?: StorageBackend } = {},
): Promise<FlushResult> {
  const windows = await claimDueWindows({ now: opts.now, limit: opts.limit ?? 25, backend: opts.backend });
  const result: FlushResult = { claimed: windows.length, flushed: 0, candidates: 0, accepted: 0, turns: 0, deferred: 0, failed: 0 };
  for (const window of windows) {
    try {
      const outcome = await flushWindow(window, { backend: opts.backend, now: opts.now });
      result.candidates += outcome.candidates;
      result.accepted += outcome.accepted;
      if (outcome.turn) result.turns += 1;
      if (outcome.state === "flushed") result.flushed += 1;
      else result.deferred += 1;
    } catch (err) {
      result.failed += 1;
      log.error("nexos.flush.failed", {
        window_id: window.id,
        nexo_id: window.nexo_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (result.claimed) log.info("nexos.flush.done", { ...result });
  return result;
}

interface WindowOutcome {
  state: "flushed" | "deferred";
  candidates: number;
  accepted: number;
  turn: boolean;
}

/** Process one claimed (`flushing`) window. Exported for tests. */
export async function flushWindow(
  window: NexoWindow,
  opts: { backend?: StorageBackend; now?: Date } = {},
): Promise<WindowOutcome> {
  const backend: StorageBackend = opts.backend ?? (isSupabaseConfigured() ? "supabase" : "demo");
  const t: NexoTarget = { workspaceId: window.workspace_id, backend };
  const out: WindowOutcome = { state: "flushed", candidates: 0, accepted: 0, turn: false };

  const nexo = await getNexoById(window.nexo_id, { backend });
  if (!nexo || nexo.workspace_id !== window.workspace_id || window.events.length === 0) {
    await markWindowFlushed(window.id, { backend });
    return out;
  }
  const block = windowBlock(window);

  // The Nexo's own cap; the run below checks it again and files the
  // "presupuesto agotado" escalation once.
  const budget = await deps.checkNexoBudget({ target: t, nexo });
  if (window.binding_id !== null && budget.ok) {
    try {
      const ingest = await ingestBlock(nexo, window, block);
      out.candidates = ingest.candidates;
      out.accepted = ingest.accepted;
    } catch (err) {
      const age = (opts.now ?? new Date()).getTime() - Date.parse(window.last_at);
      if (age < GIVE_UP_AFTER_MS) {
        log.warn("nexos.flush.extract_deferred", {
          window_id: window.id,
          nexo_id: nexo.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return { ...out, state: "deferred" };
      }
      log.error("nexos.flush.extract_gave_up", {
        window_id: window.id,
        nexo_id: nexo.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (nexo.status === "active") {
    try {
      await deps.runNexo({ nexo, trigger: "batch", input: { instruction: BATCH_INSTRUCTION, block }, target: t });
      out.turn = true;
    } catch (err) {
      log.warn("nexos.flush.turn_failed", {
        window_id: window.id,
        nexo_id: nexo.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await markWindowFlushed(window.id, { backend });
  return out;
}

const BATCH_INSTRUCTION =
  "Este bloque es una conversación que ha terminado (o ha llegado a su límite) en una de tus fuentes. " +
  "Lo relevante ya se ha extraído al cerebro. Decide si hace falta responder, preparar un borrador o escalar; " +
  "los mensajes que te mencionaban directamente ya se respondieron en su momento, no los repitas. " +
  "Si no hace falta nada, responde NO_REPLY.";

type Block = NonNullable<RunNexoInput["block"]>;

/** `slack:<team>:<channel>:<thread>` → channel + thread, plus the install the events came from. */
export function windowBlock(window: NexoWindow): Block {
  const [, , channelFromKey, threadFromKey] = window.source_key.split(":");
  const first = window.events[0] ?? ({} as Record<string, unknown>);
  const channel = typeof first.channel === "string" ? first.channel : channelFromKey;
  const threadTs = typeof first.thread_ts === "string" ? first.thread_ts : threadFromKey;
  return {
    source_key: window.source_key,
    connector_id: typeof first.connector_id === "string" ? first.connector_id : "slack",
    install_id: typeof first.install_id === "string" ? first.install_id : "",
    ...(channel ? { channel } : {}),
    ...(threadTs && /^\d+\.\d+$/.test(threadTs) ? { thread_ts: threadTs } : {}),
    messages: window.events.map((e) => ({ ts: String(e.ts), author: String(e.author), text: String(e.text) })),
  };
}

/** One signal per message: stable ids make a re-flush propose the same candidates. */
export function blockSignals(block: Block): IngestSignal[] {
  return block.messages.map((m) => ({
    external_id: `${block.source_key}:${m.ts}`,
    title: `${block.channel ? `#${block.channel}` : block.source_key} · ${m.author}`,
    text: m.text,
    author: m.author,
    at: slackTsToIso(m.ts),
    kind_hint: "message",
  }));
}

function slackTsToIso(ts: string): string | undefined {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(Math.floor(n * 1000)).toISOString() : undefined;
}

async function ingestBlock(nexo: Nexo, window: NexoWindow, block: Block): Promise<{ candidates: number; accepted: number }> {
  const signals = blockSignals(block);
  let batch;
  try {
    batch = await deps.extractBatch({
      workspaceId: nexo.workspace_id,
      sourceHint: `${block.connector_id}:nexo-window`,
      guidance: nexoGuidance(nexo),
      signals,
      usage: { surface: "nexo", metadata: { nexo_id: nexo.id, window_id: window.id } },
    });
  } catch (err) {
    // No gateway key = nothing can be extracted, now or on retry.
    if (err instanceof ExtractCandidateError && err.code === "no_gateway_key") return { candidates: 0, accepted: 0 };
    throw err;
  }

  const byId = new Map(signals.map((s) => [s.external_id, s]));
  let candidates = 0;
  let accepted = 0;
  for (const c of batch.candidates) {
    const evidence = c.evidence.map((e) => ({
      source: block.connector_id,
      external_id: e.external_id,
      excerpt: e.excerpt,
      at: byId.get(e.external_id)?.at,
    }));
    const candidate = await deps.proposeCandidate({
      workspaceId: nexo.workspace_id,
      source: block.connector_id,
      externalId: batchExternalId(c.kind, c.evidence),
      kind: c.kind,
      title: c.title,
      contentMd: c.contentMd,
      confidence: c.confidence,
      provenance: {
        connector: block.connector_id,
        install_id: block.install_id,
        extractor: "nexo_window",
        model: batch.model,
        evidence,
        nexo_id: nexo.id,
        nexo_agent_id: nexo.agent_id,
        nexo_name: nexo.name,
        window_id: window.id,
        source_key: window.source_key,
      },
    });
    candidates += 1;
    const outcome = await deps.triageCandidate(candidate, { evidence });
    if (outcome.kind === "accepted") accepted += 1;
  }
  return { candidates, accepted };
}

/** The Nexo's mission is the lens the extractor reads the block through. */
function nexoGuidance(nexo: Nexo): string | null {
  const q = nexo.questionnaire ?? {};
  const parts = [
    typeof q.mission === "string" && q.mission.trim() ? q.mission.trim() : nexo.description,
    typeof q.escalate_when === "string" && q.escalate_when.trim() ? `Presta atención especial a: ${q.escalate_when.trim()}` : "",
  ].filter(Boolean);
  return parts.length ? `${nexo.name}: ${parts.join("\n")}` : null;
}
