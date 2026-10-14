/**
 * monday.com — `monday` → Nango `monday` (OAuth2; proxy base
 * https://api.monday.com). One GraphQL call per board page: `items_page`
 * filtered on the built-in `__last_updated__` column (greater_than the
 * cursor), with column values flattened and the item's updates (the
 * discussion) as the body. Boards: `config.boards` (ids) or the first 50
 * active boards the token can see.
 *
 * Assumptions (monday API 2024-10): `items_page.query_params.rules` accepts
 * `{ column_id: "__last_updated__", compare_value: ["EXACT", <ISO>],
 * operator: greater_than }`; `updates.text_body` is the plain-text body.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface MondayUpdate {
  id?: string;
  text_body?: string | null;
  body?: string | null;
  created_at?: string;
  creator?: { name?: string } | null;
}

interface MondayItem {
  id: string;
  name?: string;
  updated_at?: string;
  url?: string;
  state?: string;
  creator?: { name?: string } | null;
  column_values?: Array<{ text?: string | null; column?: { title?: string } }>;
  updates?: MondayUpdate[];
}

interface MondayBoard {
  id: string;
  name?: string;
  url?: string;
  items_page?: { cursor?: string | null; items?: MondayItem[] };
}

export const MONDAY_API_VERSION = "2024-10";

export function mondayQuery(boards: string[] | null, since: Date, limit: number): string {
  const selector = boards
    ? `boards(ids: [${boards.map((b) => JSON.stringify(b)).join(", ")}])`
    : "boards(limit: 50, state: active, order_by: used_at)";
  const rules = `{column_id: "__last_updated__", compare_value: ["EXACT", ${JSON.stringify(since.toISOString())}], operator: greater_than}`;
  return `query { ${selector} { id name url items_page(limit: ${Math.min(100, limit)}, query_params: {rules: [${rules}], order_by: [{column_id: "__last_updated__", direction: desc}]}) { cursor items { id name updated_at url state creator { name } column_values { text column { title } } updates(limit: 10) { id text_body created_at creator { name } } } } } }`;
}

export const mondayAdapter: NangoAdapter = {
  id: "monday",
  provider: "monday",
  sourceHint: "monday:items",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const boards = allowList(config, "boards");
    const res = await client.proxy<{ data?: { boards?: MondayBoard[] }; errors?: Array<{ message?: string }> }>({
      method: "POST",
      providerConfigKey: "monday",
      connectionId,
      path: "/v2",
      headers: { "API-Version": MONDAY_API_VERSION },
      body: { query: mondayQuery(boards, since, limit) },
    });
    if (!res.ok) throw new Error(`monday query failed (${res.status})`);
    if (res.data?.errors?.length) throw new Error(`monday query error: ${res.data.errors[0]?.message ?? "?"}`);
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { boards: 0, items: 0 };
    for (const board of res.data?.data?.boards ?? []) {
      stats.boards = (stats.boards ?? 0) + 1;
      for (const item of board.items_page?.items ?? []) {
        const columns = (item.column_values ?? [])
          .filter((c) => c.text && c.text.trim())
          .map((c) => `${c.column?.title ?? "?"}: ${c.text}`)
          .join(" · ");
        const updates = (item.updates ?? [])
          .map((u) => `- ${u.creator?.name ?? "someone"} (${u.created_at ?? ""}): ${(u.text_body ?? u.body ?? "").trim()}`)
          .join("\n");
        signals.push({
          external_id: `item:${item.id}`,
          title: `${board.name ?? "Board"} · ${item.name ?? item.id}`,
          text: clip([columns ? columns : null, updates ? `\nUpdates:\n${updates}` : null].filter(Boolean).join("\n")),
          url: item.url ?? board.url,
          author: item.creator?.name ?? undefined,
          at: item.updated_at,
          kind_hint: "item",
        });
        stats.items = (stats.items ?? 0) + 1;
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
