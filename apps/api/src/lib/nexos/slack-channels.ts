/**
 * The Slack channels a Nexo could listen to through one install, for the
 * channel picker of the web's "give this source to a Nexo" dialog
 * (`GET /api/nexos/channels`). Public channels plus the private ones the bot
 * was invited to — Slack only lists private channels the token can see.
 *
 * Must not break:
 *   - The install must belong to the workspace and not be uninstalled; an id
 *     from another tenant is `install_not_found`, never a listing.
 *   - Non-Slack installs answer `unsupported` so the web falls back to typed
 *     channel ids instead of showing an empty picker.
 *   - Bounded: pages of 200 up to `MAX_CHANNELS`; `truncated` says so.
 *   - An install consented without `groups:read` still lists its public
 *     channels: `missing_scope` on the combined call retries public only.
 */
import type { NexoSlackChannel } from "@bcontext-dev/contract/nexos";
import type { ConnectorInstall } from "@/lib/connectors/installs";
import { slackCall, slackDeps, slackTransport } from "./slack-api";
import type { NexoTarget } from "./types";

export const MAX_CHANNELS = 1000;
const PAGE = 200;

type ConversationsPage = {
  ok?: boolean;
  error?: string;
  channels?: { id?: string; name?: string; is_private?: boolean; is_member?: boolean }[];
  response_metadata?: { next_cursor?: string };
};

export type ListSlackChannelsResult =
  | { ok: true; channels: NexoSlackChannel[]; truncated: boolean }
  | { ok: false; error: "install_not_found" | "unsupported" | (string & {}) };

export async function listSlackChannels(t: NexoTarget, installId: string): Promise<ListSlackChannelsResult> {
  if (t.backend === "demo") return { ok: false, error: "unsupported" };
  const install = await slackDeps.getInstall(installId).catch(() => null);
  if (!install || install.workspace_id !== t.workspaceId || install.status === "uninstalled") {
    return { ok: false, error: "install_not_found" };
  }
  if (!slackTransport(install)) return { ok: false, error: "unsupported" };

  const both = await collect(install, "public_channel,private_channel");
  if (!both.ok && both.error === "missing_scope") return collect(install, "public_channel");
  return both;
}

async function collect(install: ConnectorInstall, types: string): Promise<ListSlackChannelsResult> {
  const out: NexoSlackChannel[] = [];
  let cursor = "";
  for (;;) {
    const page = await slackCall<ConversationsPage>(install, {
      api: "conversations.list",
      method: "GET",
      query: { types, exclude_archived: "true", limit: String(PAGE), ...(cursor ? { cursor } : {}) },
    });
    if (!page.ok) return page;
    for (const c of page.data.channels ?? []) {
      if (!c.id) continue;
      out.push({ id: c.id, name: c.name ?? c.id, is_private: Boolean(c.is_private), is_member: Boolean(c.is_member) });
      if (out.length >= MAX_CHANNELS) return { ok: true, channels: sortChannels(out), truncated: true };
    }
    cursor = page.data.response_metadata?.next_cursor ?? "";
    if (!cursor) return { ok: true, channels: sortChannels(out), truncated: false };
  }
}

/** Channels the bot is already in first (they work without an invite), then by name. */
function sortChannels(list: NexoSlackChannel[]): NexoSlackChannel[] {
  return list.sort((a, b) => Number(b.is_member) - Number(a.is_member) || a.name.localeCompare(b.name));
}
