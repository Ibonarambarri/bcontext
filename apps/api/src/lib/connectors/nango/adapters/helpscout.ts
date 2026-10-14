/**
 * Help Scout — `helpscout` → Nango `helpscout-mailbox` (OAuth2). Conversations
 * modified since the cursor via `GET /v2/conversations?modifiedSince=…` with
 * threads embedded, newest first, up to four pages; `config.mailbox_ids`
 * narrows to specific mailboxes (one listing per mailbox). The Docs API lives
 * on another host and is not read here.
 *
 * Assumptions (docs, not exercised live): envelope `{ _embedded: {
 * conversations }, page: { number, totalPages } }`; threads under
 * `_embedded.threads` with `body` HTML, `createdBy { first, last, type }`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, htmlToText, type NangoAdapter } from "./shared";

interface HsPerson {
  first?: string;
  last?: string;
  email?: string;
  type?: string;
}

interface HsThread {
  id: number;
  type?: string;
  status?: string;
  body?: string;
  createdAt?: string;
  createdBy?: HsPerson;
}

interface HsConversation {
  id: number;
  number?: number;
  subject?: string;
  status?: string;
  type?: string;
  mailboxId?: number;
  assignee?: HsPerson | null;
  tags?: Array<{ tag?: string }>;
  createdAt?: string;
  userUpdatedAt?: string;
  customerWaitingSince?: { time?: string };
  closedAt?: string;
  _embedded?: { threads?: HsThread[] };
}

interface HsPage {
  _embedded?: { conversations?: HsConversation[] };
  page?: { number?: number; totalPages?: number };
}

const MAX_PAGES = 4;

function name(p?: HsPerson | null): string {
  if (!p) return "";
  return [p.first, p.last].filter(Boolean).join(" ").trim() || p.email || "";
}

export const helpscoutAdapter: NangoAdapter = {
  id: "helpscout",
  provider: "helpscout-mailbox",
  sourceHint: "helpscout:conversations",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const mailboxes = allowList(config, "mailbox_ids");
    const scopes: Array<string | null> = mailboxes ? mailboxes.slice(0, 5) : [null];
    const signals: IngestSignal[] = [];
    let pages = 0;
    for (const mailbox of scopes) {
      let page = 1;
      let totalPages = 1;
      do {
        const res = await client.proxy<HsPage>({
          method: "GET",
          providerConfigKey: "helpscout",
          connectionId,
          path: "/v2/conversations",
          query: {
            modifiedSince: since.toISOString(),
            status: "all",
            sortField: "modifiedAt",
            sortOrder: "desc",
            embed: "threads",
            page,
            ...(mailbox ? { mailbox } : {}),
          },
        });
        if (!res.ok) throw new Error(`helpscout conversations failed (${res.status})`);
        pages += 1;
        totalPages = res.data?.page?.totalPages ?? 1;
        for (const c of res.data?._embedded?.conversations ?? []) {
          const threads = (c._embedded?.threads ?? [])
            .filter((t) => t.body && t.type !== "lineitem")
            .slice(0, 6);
          const lines = [
            `Status: ${c.status ?? "?"}${c.type ? ` · Type: ${c.type}` : ""}` +
              (c.assignee ? ` · Assignee: ${name(c.assignee)}` : "") +
              (c.tags?.length ? ` · Tags: ${c.tags.map((t) => t.tag).filter(Boolean).join(", ")}` : ""),
          ];
          if (threads.length) {
            lines.push("", "Thread:");
            for (const t of threads) {
              const who = name(t.createdBy) || t.createdBy?.type || "someone";
              lines.push(`- ${who} (${t.createdAt ?? ""}): ${clip(htmlToText(t.body ?? ""), 1500)}`);
            }
          }
          signals.push({
            external_id: `conversation:${c.id}`,
            title: `#${c.number ?? c.id} · ${c.subject?.trim() || "(no subject)"}`,
            text: clip(lines.join("\n")),
            url: `https://secure.helpscout.net/conversation/${c.id}/${c.number ?? c.id}`,
            author: name(c.assignee) || undefined,
            at: c.closedAt ?? c.userUpdatedAt ?? c.createdAt,
            kind_hint: "conversation",
          });
          if (signals.length >= limit) break;
        }
        page += 1;
      } while (page <= totalPages && page <= MAX_PAGES && signals.length < limit);
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats: { pages, mailboxes: scopes.length } };
  },
};
