/**
 * Google Chat — `google-chat` → Nango `google-chat` (OAuth2 via the `google`
 * provider; proxy base https://chat.googleapis.com, Chat API v1 with user
 * authentication).
 *
 *   GET /v1/spaces?filter=spaceType = "SPACE"&pageSize=100        (≤3 pages)
 *   GET /v1/spaces/{space}/messages?filter=createTime > "<since>"
 *       &orderBy=createTime desc&pageSize=100                      (≤3 pages per space)
 *
 * Signals, like the Slack twin: a thread that got two or more messages in
 * the window is one signal (`thread:<space>:<thread>`); everything else in
 * a space is grouped per UTC day (`space:<space>:<day>`). Messages posted
 * by Chat apps (`sender.type === "BOT"`) and deleted messages are skipped.
 * Only named spaces are read by default (`config.space_types`, e.g.
 * `["SPACE", "GROUP_CHAT"]`, widens it; direct messages are never read);
 * `config.spaces` (resource names or display names) narrows the list.
 *
 * Scopes: chat.spaces.readonly + chat.messages.readonly. Assumptions (docs,
 * not exercised live): `spaces.list` honours the `spaceType` filter under
 * user auth; `messages.list` accepts `createTime > "<RFC 3339>"`;
 * `sender.displayName` may be empty under user auth, in which case the
 * `users/<id>` resource name is what NEXO sees; permalinks follow the
 * `https://chat.google.com/room/<space>/<thread>` shape.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface ChatSpace {
  name: string;
  displayName?: string;
  spaceType?: string;
  spaceUri?: string;
}

interface ChatMessage {
  name: string;
  sender?: { name?: string; displayName?: string; type?: string };
  createTime?: string;
  text?: string;
  formattedText?: string;
  thread?: { name?: string };
  threadReply?: boolean;
  attachment?: Array<{ contentName?: string }>;
  emojiReactionSummaries?: Array<{ emoji?: { unicode?: string }; reactionCount?: number }>;
  deletionMetadata?: { deletionType?: string };
}

interface Page<T> {
  spaces?: T[];
  messages?: T[];
  nextPageToken?: string;
}

const SPACE_PAGES = 3;
const MESSAGE_PAGES = 3;
const SPACES_MAX = 25;
const DEFAULT_SPACE_TYPES = ["SPACE"];

/** `spaces/AAA` → `AAA`; `spaces/AAA/threads/TTT` → `TTT`. */
export function lastSegment(name: string | undefined): string {
  return (name ?? "").split("/").pop() ?? "";
}

export function chatSpaceFilter(types: string[]): string {
  return types.map((t) => `spaceType = "${t.replace(/"/g, "")}"`).join(" OR ");
}

export function chatMessageFilter(since: Date): string {
  return `createTime > "${since.toISOString()}"`;
}

/** `spaceUri` when Chat returns it, else the room link built from the ids. */
export function chatPermalink(space: ChatSpace, threadName?: string): string {
  const spaceId = lastSegment(space.name);
  const thread = lastSegment(threadName);
  if (thread) return `https://chat.google.com/room/${spaceId}/${thread}`;
  return space.spaceUri || `https://chat.google.com/room/${spaceId}`;
}

function senderName(m: ChatMessage): string {
  return m.sender?.displayName || m.sender?.name || "someone";
}

export const googleChatAdapter: NangoAdapter = {
  id: "google-chat",
  provider: "google-chat",
  sourceHint: "google-chat:spaces",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const get = <T>(path: string, query: Record<string, string | number | boolean | undefined>) =>
      client.proxy<Page<T>>({ method: "GET", providerConfigKey: "google-chat", connectionId, path, query });
    const stats: Record<string, number> = { spaces: 0, messages: 0, threads: 0 };

    const types = (allowList(config, "space_types") ?? DEFAULT_SPACE_TYPES).filter((t) => t !== "DIRECT_MESSAGE");
    const wanted = allowList(config, "spaces");
    const spaces: ChatSpace[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < SPACE_PAGES; page += 1) {
      const res = await get<ChatSpace>("/v1/spaces", { filter: chatSpaceFilter(types), pageSize: 100, ...(pageToken ? { pageToken } : {}) });
      if (!res.ok) throw new Error(`google-chat spaces.list failed (${res.status})`);
      spaces.push(...(res.data?.spaces ?? []));
      pageToken = res.data?.nextPageToken || undefined;
      if (!pageToken) break;
    }
    const selected = spaces
      .filter((s) => !wanted || wanted.includes(s.name) || wanted.includes(lastSegment(s.name)) || (s.displayName ? wanted.includes(s.displayName) : false))
      .slice(0, SPACES_MAX);
    stats.spaces = selected.length;

    const signals: IngestSignal[] = [];
    const render = (m: ChatMessage) => {
      const hhmm = (m.createTime ?? "").slice(11, 16);
      const files = m.attachment?.length ? ` [${m.attachment.map((a) => a.contentName ?? "file").join(", ")}]` : "";
      const reactions = m.emojiReactionSummaries?.length
        ? ` (${m.emojiReactionSummaries.map((r) => `${r.emoji?.unicode ?? "?"} ${r.reactionCount ?? 1}`).join(" ")})`
        : "";
      return `[${hhmm}] ${senderName(m)}${m.threadReply ? " (reply)" : ""}: ${(m.formattedText || m.text || "").trim()}${files}${reactions}`;
    };

    for (const space of selected) {
      if (signals.length >= limit) break;
      const label = space.displayName || lastSegment(space.name);
      const messages: ChatMessage[] = [];
      let next: string | undefined;
      for (let page = 0; page < MESSAGE_PAGES; page += 1) {
        const res = await get<ChatMessage>(`/v1/${space.name}/messages`, {
          filter: chatMessageFilter(since),
          orderBy: "createTime desc",
          pageSize: 100,
          ...(next ? { pageToken: next } : {}),
        });
        if (!res.ok) {
          stats.forbidden = (stats.forbidden ?? 0) + 1;
          break;
        }
        messages.push(...(res.data?.messages ?? []));
        next = res.data?.nextPageToken || undefined;
        if (!next) break;
      }
      const keep = messages
        .filter((m) => m.sender?.type !== "BOT" && !m.deletionMetadata && (m.formattedText || m.text || "").trim())
        .sort((a, b) => (a.createTime ?? "").localeCompare(b.createTime ?? ""));
      stats.messages = (stats.messages ?? 0) + keep.length;
      if (!keep.length) continue;

      const byThread = new Map<string, ChatMessage[]>();
      for (const m of keep) {
        const key = m.thread?.name ?? m.name;
        byThread.set(key, [...(byThread.get(key) ?? []), m]);
      }

      const loose: ChatMessage[] = [];
      for (const [threadName, list] of byThread) {
        if (list.length < 2) {
          loose.push(...list);
          continue;
        }
        if (signals.length >= limit) break;
        stats.threads = (stats.threads ?? 0) + 1;
        const first = list[0]!;
        const last = list[list.length - 1]!;
        signals.push({
          external_id: `thread:${lastSegment(space.name)}:${lastSegment(threadName)}`,
          title: `${label} · ${clip((first.formattedText || first.text || "").trim(), 80).replace(/\n/g, " ")}`,
          text: clip(list.map(render).join("\n"), 20_000),
          url: chatPermalink(space, threadName),
          author: senderName(first),
          at: last.createTime,
          kind_hint: "thread",
        });
      }

      const byDay = new Map<string, ChatMessage[]>();
      for (const m of loose) {
        const day = (m.createTime ?? "").slice(0, 10) || "unknown";
        byDay.set(day, [...(byDay.get(day) ?? []), m]);
      }
      for (const [day, list] of byDay) {
        if (signals.length >= limit) break;
        signals.push({
          external_id: `space:${lastSegment(space.name)}:${day}`,
          title: `${label} · ${day}`,
          text: clip(list.map(render).join("\n"), 20_000),
          url: chatPermalink(space, list[0]!.thread?.name),
          at: list[list.length - 1]!.createTime,
          kind_hint: "channel_day",
        });
      }
    }

    return { signals: signals.slice(0, limit), stats };
  },
};
