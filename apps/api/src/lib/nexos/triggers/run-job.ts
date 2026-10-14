/**
 * The `nexos.run` job: one Nexo turn from a queued trigger. Turns the job
 * payload (Nexo id + trigger + what it needs) into the runner's input and
 * calls `runNexo` — no model or tool logic here.
 *
 * Producers: `./heartbeat` (trigger `heartbeat`), `./windows` (fast `event`
 * turns for mentions/DMs), and anything that wants a queued `manual` or
 * `batch` turn with an explicit `input`.
 *
 * Must not break:
 *   - The Nexo is re-read when the job starts: a Nexo deleted, paused or
 *     moved since the enqueue is skipped, never run on stale settings, and
 *     the payload's workspace must match the row (a forged id from another
 *     tenant is a skip).
 *   - An `event` turn reads its thread's window when it STARTS, so the burst
 *     that collapsed into this one job is seen whole.
 */
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import type { StorageBackend } from "@/lib/storage";
import { runNexo, type RunNexoInput } from "../runtime/runner";
import { getNexoById, listWindows } from "../store";
import type { NexoTarget } from "../types";
import { windowBlock } from "./flush";
import { heartbeatInstruction } from "./heartbeat";

const TRIGGERS = ["heartbeat", "event", "batch", "manual"] as const;
type QueuedTrigger = (typeof TRIGGERS)[number];

/** Most recent messages an event turn sees from its thread. */
const EVENT_CONTEXT_MESSAGES = 30;

const deps = { runNexo: (...a: Parameters<typeof runNexo>) => runNexo(...a) };

export function setRunJobDepsForTests(patch: Partial<typeof deps> | null): void {
  deps.runNexo = patch?.runNexo ?? ((...a) => runNexo(...a));
}

const EVENT_INSTRUCTION =
  "Te acaban de mencionar o escribir directamente en este hilo. Responde al último mensaje que va dirigido a ti, " +
  "con el contexto del hilo. Si no te corresponde, escala o responde NO_REPLY.";

export async function runNexoJob(
  data: Record<string, unknown> | undefined,
  opts: { backend?: StorageBackend } = {},
): Promise<Record<string, unknown>> {
  const backend: StorageBackend = opts.backend ?? (isSupabaseConfigured() ? "supabase" : "demo");
  const nexoId = str(data?.nexo_id);
  const trigger = str(data?.trigger) as QueuedTrigger | null;
  if (!nexoId || !trigger || !TRIGGERS.includes(trigger)) return { skipped: "invalid_payload" };

  const nexo = await getNexoById(nexoId, { backend });
  if (!nexo) return { skipped: "nexo_missing" };
  const workspaceId = str(data?.workspace_id);
  if (workspaceId && workspaceId !== nexo.workspace_id) return { skipped: "workspace_mismatch" };
  if (nexo.status !== "active") return { skipped: "nexo_paused" };
  if (trigger === "heartbeat" && !nexo.heartbeat.enabled) return { skipped: "heartbeat_off" };

  const target: NexoTarget = { workspaceId: nexo.workspace_id, backend };
  let input: RunNexoInput;
  if (trigger === "heartbeat") {
    input = { instruction: heartbeatInstruction(nexo) };
  } else if (trigger === "event") {
    const sourceKey = str(data?.source_key);
    if (!sourceKey) return { skipped: "no_source_key" };
    // Newest window of the thread, whatever its state: the flush may already
    // have claimed it between the enqueue and now.
    const windows = await listWindows(target, { nexoId: nexo.id, limit: 200 });
    const window = windows.find((w) => w.source_key === sourceKey);
    if (!window) return { skipped: "no_window" };
    const block = windowBlock(window);
    input = {
      instruction: EVENT_INSTRUCTION,
      block: {
        ...block,
        connector_id: str(data?.connector_id) ?? block.connector_id,
        install_id: str(data?.install_id) ?? block.install_id,
        ...(str(data?.channel) ? { channel: str(data?.channel)! } : {}),
        ...(str(data?.thread_ts) ? { thread_ts: str(data?.thread_ts)! } : {}),
        messages: block.messages.slice(-EVENT_CONTEXT_MESSAGES),
      },
    };
  } else {
    const raw = data?.input;
    input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as RunNexoInput) : {};
  }

  const run = await deps.runNexo({ nexo, trigger, input, target });
  return { nexo_id: nexo.id, trigger, run_id: run.runId, status: run.status };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
