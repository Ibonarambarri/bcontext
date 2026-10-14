/**
 * Miro — `miro` → Nango `miro` (OAuth2; proxy base https://api.miro.com).
 * Boards modified after the cursor (`/v2/boards?sort=last_modified`,
 * filtered on `modifiedAt` client-side — the API has no "since" param),
 * then the textual items of each board (`/v2/boards/{id}/items?type=…`
 * for sticky notes, text and cards; one `type` per request, cursor
 * paginated). One signal per board with every item's text concatenated
 * and capped at ~20 KB, so a workshop board becomes one dense signal.
 * `config.boards` narrows to board ids.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, htmlToText, type NangoAdapter } from "./shared";

interface MiroBoard {
  id: string;
  name?: string;
  description?: string;
  viewLink?: string;
  modifiedAt?: string;
  modifiedBy?: { name?: string };
  owner?: { name?: string };
}

interface MiroItem {
  id: string;
  type?: string;
  data?: { content?: string; title?: string; description?: string };
  createdBy?: { name?: string };
}

interface MiroList<T> {
  data?: T[];
  cursor?: string;
}

export const MIRO_ITEM_TYPES = ["sticky_note", "text", "card"] as const;
const MAX_BOARDS = 20;
const MAX_ITEM_PAGES = 4;
const BOARD_TEXT_CAP = 20000;

export const miroAdapter: NangoAdapter = {
  id: "miro",
  provider: "miro",
  sourceHint: "miro:boards",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const wanted = allowList(config, "boards");
    const boards: MiroBoard[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await client.proxy<MiroList<MiroBoard>>({
        method: "GET",
        providerConfigKey: "miro",
        connectionId,
        path: "/v2/boards",
        query: { sort: "last_modified", limit: 50, ...(cursor ? { cursor } : {}) },
      });
      if (!res.ok) throw new Error(`miro boards failed (${res.status})`);
      const rows = res.data?.data ?? [];
      let anyRecent = false;
      for (const b of rows) {
        if (wanted && !wanted.includes(b.id)) continue;
        if (b.modifiedAt && new Date(b.modifiedAt) > since) {
          anyRecent = true;
          if (!seen.has(b.id)) {
            seen.add(b.id);
            boards.push(b);
          }
        }
      }
      // Sorted by last_modified desc: once a page has nothing recent, stop.
      cursor = anyRecent ? res.data?.cursor : undefined;
      pages++;
    } while (cursor && pages < MAX_ITEM_PAGES && boards.length < MAX_BOARDS);

    const signals: IngestSignal[] = [];
    const stats = { boards: boards.length, items: 0 };

    for (const board of boards.slice(0, MAX_BOARDS)) {
      const lines: string[] = [];
      for (const type of MIRO_ITEM_TYPES) {
        let itemCursor: string | undefined;
        let itemPages = 0;
        do {
          const res = await client.proxy<MiroList<MiroItem>>({
            method: "GET",
            providerConfigKey: "miro",
            connectionId,
            path: `/v2/boards/${encodeURIComponent(board.id)}/items`,
            query: { type, limit: 50, ...(itemCursor ? { cursor: itemCursor } : {}) },
          });
          if (!res.ok) throw new Error(`miro items of ${board.id} failed (${res.status})`);
          for (const it of res.data?.data ?? []) {
            const text = [it.data?.title, it.data?.content, it.data?.description]
              .filter(Boolean)
              .map((s) => htmlToText(String(s)))
              .filter(Boolean)
              .join(" — ");
            if (!text) continue;
            stats.items++;
            lines.push(`[${type}${it.createdBy?.name ? ` · ${it.createdBy.name}` : ""}] ${text}`);
          }
          itemCursor = res.data?.cursor;
          itemPages++;
        } while (itemCursor && itemPages < MAX_ITEM_PAGES);
      }
      signals.push({
        external_id: `board:${board.id}`,
        title: board.name ?? `Miro board ${board.id}`,
        text: [
          board.description ? `${board.description}\n` : null,
          `Modified: ${board.modifiedAt ?? "?"}${board.modifiedBy?.name ? ` by ${board.modifiedBy.name}` : ""}`,
          lines.length ? `\nItems (${lines.length}):\n${clip(lines.join("\n"), BOARD_TEXT_CAP)}` : "\n(No textual items on the board.)",
        ]
          .filter(Boolean)
          .join("\n"),
        url: board.viewLink,
        author: board.modifiedBy?.name ?? board.owner?.name,
        at: board.modifiedAt,
        kind_hint: "board",
      });
      if (signals.length >= limit) break;
    }

    return { signals: signals.slice(0, limit), stats };
  },
};
