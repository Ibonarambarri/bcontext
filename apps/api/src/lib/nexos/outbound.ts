/**
 * The one way a Nexo speaks outside Bcontext: post a message through a
 * connector install it is bound to. Today that is Slack, either the
 * first-party app (bot token in the install's secret) or the Nango-backed
 * `slack-nango` install (token held by Nango, call goes through its proxy).
 * Every other connector answers `unsupported`. The token-or-proxy plumbing
 * is `slack-api.ts`, shared with the channel picker.
 *
 * Callers: the runtime's `reply` tool when autonomy is `act`, and the inbox
 * route when a person approves or edits a `draft_reply`. Neither checks the
 * autonomy here — that decision is theirs; this module only delivers.
 *
 * Must not break:
 *   - The install must belong to the target workspace and be active; an id
 *     from another tenant is "not found", never a send.
 *   - Never throws: a Slack/Nango failure is `{ ok: false, error }` so a reply
 *     tool or an approval can report it instead of crashing the run.
 *   - Every attempt is audited (`nexo.message.send`) as the Nexo's agent,
 *     success or not; the text is hashed by the audit layer, never stored.
 *   - The display-name override is only sent when the install granted
 *     `chat:write.customize`: without it Slack rejects or ignores the field,
 *     and a message that fails just to show a name is worse than an unnamed one.
 */
import { appendAudit } from "@/lib/audit";
import { log } from "@bcontext-dev/contract/log";
import { setSlackDepsForTests, slackCall, slackDeps, type SlackDeps } from "./slack-api";
import type { Nexo, NexoTarget } from "./types";

export type SendNexoMessageResult = { ok: true; ts?: string } | { ok: false; error: string };

export interface SendNexoMessageArgs {
  target: NexoTarget;
  nexo: Nexo;
  installId: string;
  channel: string;
  threadTs?: string;
  text: string;
}

/** Slack's hard limit is 40k chars; stay well under it. */
const MAX_TEXT = 39_000;

/** Test seam: the Slack fetch, the Nango client and the install lookup (shared with `slack-api`). */
export function setOutboundDepsForTests(patch: Partial<SlackDeps> | null): void {
  setSlackDepsForTests(patch);
}

export async function sendNexoMessage(args: SendNexoMessageArgs): Promise<SendNexoMessageResult> {
  const result = await deliver(args).catch((err: unknown): SendNexoMessageResult => ({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  }));
  if (args.target.backend !== "demo") {
    void appendAudit({
      workspaceId: args.target.workspaceId,
      actorType: "agent",
      actorId: args.nexo.agent_id,
      agentTokenId: args.nexo.agent_id,
      action: "nexo.message.send",
      targetType: "connector_install",
      targetId: args.installId,
      input: { nexo_id: args.nexo.id, channel: args.channel, thread_ts: args.threadTs ?? null, text: args.text },
      output: result,
    });
  }
  if (!result.ok) {
    log.warn("nexos.outbound.failed", {
      workspace_id: args.target.workspaceId,
      nexo_id: args.nexo.id,
      install_id: args.installId,
      error: result.error,
    });
  }
  return result;
}

async function deliver(args: SendNexoMessageArgs): Promise<SendNexoMessageResult> {
  const text = args.text.trim().slice(0, MAX_TEXT);
  if (!text) return { ok: false, error: "empty_text" };
  if (!args.channel) return { ok: false, error: "missing_channel" };
  if (args.target.backend === "demo") return { ok: false, error: "unsupported" };

  const install = await slackDeps.getInstall(args.installId);
  if (!install || install.workspace_id !== args.target.workspaceId) return { ok: false, error: "install_not_found" };
  if (install.status !== "active") return { ok: false, error: "install_inactive" };

  const sent = await slackCall<{ ok?: boolean; ts?: string; error?: string }>(install, {
    api: "chat.postMessage",
    method: "POST",
    body: slackBody(args, install.config, text),
  });
  return sent.ok ? { ok: true, ts: sent.data.ts } : sent;
}

/** Scopes the install consented to, as recorded by the OAuth callback (`config.scopes`). */
export function grantedScopes(config: Record<string, unknown>): Set<string> {
  const raw = config.scopes;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return new Set(list.map((s) => String(s).trim()).filter(Boolean));
}

function slackBody(args: SendNexoMessageArgs, config: Record<string, unknown>, text: string): Record<string, unknown> {
  const body: Record<string, unknown> = { channel: args.channel, text, unfurl_links: false };
  if (args.threadTs) body.thread_ts = args.threadTs;
  if (grantedScopes(config).has("chat:write.customize")) body.username = args.nexo.name;
  return body;
}
