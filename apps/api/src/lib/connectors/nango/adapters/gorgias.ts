/**
 * Gorgias — `gorgias` → Nango `gorgias-basic` (BASIC: account email + API
 * key; connection_config.subdomain). Tickets ordered by `updated_datetime`
 * desc through the cursor-paginated list, stopping at the first ticket older
 * than the cursor; the last messages of the first few tickets are attached.
 * `config.channels` (email, chat, phone, …) filters client-side.
 *
 * Assumptions (docs, not exercised live): list envelope `{ data, meta: {
 * next_cursor } }`; ticket messages `{ data: [{ body_text, sender, from_agent,
 * created_datetime }] }`; app URL `https://<subdomain>.gorgias.com/app/ticket/<id>`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, htmlToText, subdomain, type NangoAdapter } from "./shared";

interface GorgiasTicket {
  id: number;
  subject?: string | null;
  status?: string;
  channel?: string;
  via?: string;
  priority?: string;
  tags?: Array<{ name?: string }>;
  assignee_user?: { name?: string; email?: string } | null;
  updated_datetime?: string;
  created_datetime?: string;
  last_message_datetime?: string;
}

interface GorgiasMessage {
  id: number;
  body_text?: string | null;
  body_html?: string | null;
  from_agent?: boolean;
  sender?: { name?: string; email?: string } | null;
  created_datetime?: string;
}

interface GorgiasPage<T> {
  data?: T[];
  meta?: { next_cursor?: string | null };
}

const MAX_PAGES = 5;
const DETAIL_LIMIT = 20;

export const gorgiasAdapter: NangoAdapter = {
  id: "gorgias",
  provider: "gorgias-basic",
  sourceHint: "gorgias:tickets",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const channels = allowList(config, "channels");
    const sub = subdomain(connectionConfig);
    const tickets: GorgiasTicket[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let reachedCursor = false;
    do {
      const res = await client.proxy<GorgiasPage<GorgiasTicket>>({
        method: "GET",
        providerConfigKey: "gorgias",
        connectionId,
        path: "/api/tickets",
        query: { order_by: "updated_datetime:desc", limit: Math.min(100, limit), ...(cursor ? { cursor } : {}) },
      });
      if (!res.ok) throw new Error(`gorgias tickets failed (${res.status})`);
      pages += 1;
      for (const t of res.data?.data ?? []) {
        const updated = t.updated_datetime ? Date.parse(t.updated_datetime) : NaN;
        if (Number.isFinite(updated) && updated <= since.getTime()) {
          reachedCursor = true;
          break;
        }
        if (channels && t.channel && !channels.includes(t.channel)) continue;
        tickets.push(t);
      }
      cursor = res.data?.meta?.next_cursor ?? undefined;
    } while (cursor && !reachedCursor && pages < MAX_PAGES && tickets.length < limit);

    const signals: IngestSignal[] = [];
    let detailed = 0;
    for (const t of tickets.slice(0, limit)) {
      const lines = [
        `Status: ${t.status ?? "?"} · Channel: ${t.channel ?? t.via ?? "?"}` +
          (t.priority ? ` · Priority: ${t.priority}` : "") +
          (t.assignee_user?.name ? ` · Assignee: ${t.assignee_user.name}` : "") +
          (t.tags?.length ? ` · Tags: ${t.tags.map((x) => x.name).filter(Boolean).join(", ")}` : ""),
      ];
      if (detailed < DETAIL_LIMIT) {
        detailed += 1;
        const res = await client.proxy<GorgiasPage<GorgiasMessage>>({
          method: "GET",
          providerConfigKey: "gorgias",
          connectionId,
          path: `/api/tickets/${t.id}/messages`,
          query: { limit: 5, order_by: "created_datetime:desc" },
        });
        const msgs = (res.ok ? res.data?.data ?? [] : []).slice(0, 5).reverse();
        if (msgs.length) {
          lines.push("", "Last messages:");
          for (const m of msgs) {
            const who = m.from_agent ? (m.sender?.name ?? "agent") : "customer";
            const body = (m.body_text ?? htmlToText(m.body_html ?? "")).trim();
            lines.push(`- ${who} (${m.created_datetime ?? ""}): ${clip(body, 1200)}`);
          }
        }
      }
      signals.push({
        external_id: `ticket:${t.id}`,
        title: `#${t.id} · ${t.subject?.trim() || "(no subject)"}`,
        text: clip(lines.join("\n")),
        url: sub ? `https://${sub}.gorgias.com/app/ticket/${t.id}` : undefined,
        author: t.assignee_user?.name ?? undefined,
        at: t.updated_datetime ?? t.last_message_datetime ?? t.created_datetime,
        kind_hint: "ticket",
      });
    }
    return { signals: signals.slice(0, limit), stats: { pages, tickets: tickets.length, detailed } };
  },
};
