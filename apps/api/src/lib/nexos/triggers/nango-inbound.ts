/**
 * Nango Slack drain → Nexos. The `slack-nango` adapter polls on cadence and
 * hands back signals already folded per thread (`thread:<channel>:<ts>`) or
 * per channel-day (`channel:<channel>:<day>`); this splits them by owner
 * before the legacy batch ingestion runs.
 *
 * Callers: the generic Nango connector's `fullSync`
 * (`src/lib/connectors/nango/index.ts`), for Slack-provider installs only.
 *
 * Must not break:
 *   - A signal of a channel a Nexo owns goes ONLY to that Nexo's window (its
 *     flush is the ingestion path); every other signal stays in `legacy` and
 *     is ingested exactly as before. The general Nexo also hears unbound
 *     signals, but its windows never re-extract (see `./flush`).
 *   - Fail-open: any error returns every remaining signal as `legacy`.
 *   - No new reads: only what the adapter already fetched is routed.
 */
import { log } from "@bcontext-dev/contract/log";
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import type { StorageBackend } from "@/lib/storage";
import { WINDOW_DEFAULTS, type NexoTarget } from "../types";
import { routeInbound, type InboundMessage } from "./routing";
import { acceptInbound } from "./windows";

/** Below the window's per-event cap, with room for the line we split on. */
const CHUNK = WINDOW_DEFAULTS.maxEventText - 200;

/** `thread:<channel>:<ts>` / `channel:<channel>:<day>` → where it was said. */
export function parseSlackSignalId(externalId: string): { channel: string; thread: string } | null {
  const m = /^(thread|channel):([^:]+):(.+)$/.exec(externalId);
  if (!m) return null;
  return { channel: m[2]!, thread: m[1] === "thread" ? m[3]! : `day-${m[3]!}` };
}

/** Split a folded signal into window-sized events on line boundaries. */
export function chunkText(text: string, size = CHUNK): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const piece = line.length > size ? line.slice(0, size) : line;
    if (current && current.length + piece.length + 1 > size) {
      out.push(current);
      current = "";
    }
    current = current ? `${current}\n${piece}` : piece;
  }
  if (current.trim()) out.push(current);
  return out;
}

export function isSlackNangoInstall(connectorId: string, config: Record<string, unknown>): boolean {
  return connectorId === "slack-nango" || config.nango_provider === "slack";
}

export async function routeNangoSignalsToNexos(input: {
  workspaceId: string;
  installId: string;
  connectorId: string;
  config: Record<string, unknown>;
  signals: IngestSignal[];
  backend?: StorageBackend;
}): Promise<{ legacy: IngestSignal[]; windowed: number }> {
  if (!isSlackNangoInstall(input.connectorId, input.config) || input.signals.length === 0) {
    return { legacy: input.signals, windowed: 0 };
  }
  const t: NexoTarget = { workspaceId: input.workspaceId, backend: input.backend ?? "supabase" };
  const conn = (input.config.nango_connection_config as Record<string, unknown> | undefined) ?? {};
  const teamId = typeof conn.team_id === "string" ? conn.team_id : input.installId;
  const legacy: IngestSignal[] = [];
  let windowed = 0;

  for (let i = 0; i < input.signals.length; i += 1) {
    const signal = input.signals[i]!;
    const where = parseSlackSignalId(signal.external_id);
    if (!where) {
      legacy.push(signal);
      continue;
    }
    try {
      const secs = Math.floor(Date.parse(signal.at ?? "") / 1000) || 0;
      const base: Omit<InboundMessage, "ts" | "text"> = {
        connectorId: input.connectorId,
        installId: input.installId,
        teamId,
        channel: where.channel,
        threadTs: where.thread,
        user: signal.author ?? null,
      };
      const chunks = chunkText(signal.text);
      const first: InboundMessage = { ...base, ts: `${secs}.000000`, text: chunks[0] ?? "" };
      const decision = await routeInbound(t, first, { installConfig: input.config, bot: {} });
      if (!decision.ownsChannel) legacy.push(signal);
      if (decision.kind !== "nexo") continue;
      for (let c = 0; c < chunks.length; c += 1) {
        await acceptInbound(t, { ...base, ts: `${secs}.${String(c).padStart(6, "0")}`, text: chunks[c]! }, decision, { bot: {} });
      }
      windowed += 1;
    } catch (err) {
      log.warn("nexos.nango_inbound.failed", {
        workspace_id: input.workspaceId,
        install_id: input.installId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { legacy: [...legacy, ...input.signals.slice(legacy.includes(signal) ? i + 1 : i)], windowed };
    }
  }
  return { legacy, windowed };
}
