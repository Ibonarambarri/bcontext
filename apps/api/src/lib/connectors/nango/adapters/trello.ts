/**
 * Trello — `trello` → Nango `trello` (OAuth1; proxy base
 * https://api.trello.com). Board actions since the cursor (card created,
 * updated/moved, commented), grouped per card into one signal that reads
 * as the card's recent history, plus the card's current description.
 *
 * Install config: `boards` (allow-list of board ids or names).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import type { NangoClient } from "@/lib/nango/client";
import { allowList, clip, type NangoAdapter } from "./shared";

interface Board { id: string; name?: string; url?: string }
interface Action {
  id: string;
  type: string;
  date?: string;
  memberCreator?: { fullName?: string; username?: string };
  data?: {
    text?: string;
    card?: { id?: string; name?: string; shortLink?: string; desc?: string };
    list?: { name?: string };
    listBefore?: { name?: string };
    listAfter?: { name?: string };
    old?: Record<string, unknown>;
  };
}
interface Card { id: string; name?: string; desc?: string; url?: string; shortUrl?: string; closed?: boolean; dateLastActivity?: string; idList?: string }

const KEY = "trello";
const MAX_BOARDS = 10;
const MAX_CARD_FETCHES = 30;
const ACTION_FILTER = "commentCard,updateCard,createCard";

export function describeAction(a: Action): string {
  const who = a.memberCreator?.fullName ?? a.memberCreator?.username ?? "someone";
  const when = a.date ?? "";
  switch (a.type) {
    case "createCard":
      return `- ${who} (${when}): created the card${a.data?.list?.name ? ` in "${a.data.list.name}"` : ""}`;
    case "commentCard":
      return `- ${who} (${when}): commented: ${clip(a.data?.text ?? "", 800)}`;
    case "updateCard": {
      if (a.data?.listBefore && a.data?.listAfter) return `- ${who} (${when}): moved from "${a.data.listBefore.name ?? "?"}" to "${a.data.listAfter.name ?? "?"}"`;
      const changed = Object.keys(a.data?.old ?? {});
      if (changed.includes("closed")) return `- ${who} (${when}): ${a.data?.old?.closed === false ? "archived" : "unarchived"} the card`;
      if (changed.includes("desc")) return `- ${who} (${when}): edited the description`;
      if (changed.includes("name")) return `- ${who} (${when}): renamed the card`;
      return `- ${who} (${when}): updated ${changed.join(", ") || "the card"}`;
    }
    default:
      return `- ${who} (${when}): ${a.type}`;
  }
}

async function fetchCard(client: NangoClient, connectionId: string, id: string): Promise<Card | null> {
  const res = await client.proxy<Card>({
    method: "GET",
    providerConfigKey: KEY,
    connectionId,
    path: `/1/cards/${encodeURIComponent(id)}`,
    query: { fields: "name,desc,url,shortUrl,closed,dateLastActivity,idList" },
  });
  return res.ok && res.data && typeof res.data === "object" ? res.data : null;
}

export const trelloAdapter: NangoAdapter = {
  id: KEY,
  provider: "trello",
  sourceHint: "trello:cards",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const boardsAllow = allowList(config, "boards");
    const res = await client.proxy<Board[]>({
      method: "GET",
      providerConfigKey: KEY,
      connectionId,
      path: "/1/members/me/boards",
      query: { filter: "open", fields: "id,name,url" },
    });
    if (!res.ok) throw new Error(`trello boards failed (${res.status})`);
    const boards = (Array.isArray(res.data) ? res.data : [])
      .filter((b) => !boardsAllow || boardsAllow.includes(b.id) || (b.name && boardsAllow.some((n) => n.toLowerCase() === b.name!.toLowerCase())))
      .slice(0, MAX_BOARDS);

    const signals: IngestSignal[] = [];
    const stats = { boards: boards.length, actions: 0, cards: 0 };
    let cardFetches = 0;
    for (const board of boards) {
      const actions = await client.proxy<Action[]>({
        method: "GET",
        providerConfigKey: KEY,
        connectionId,
        path: `/1/boards/${encodeURIComponent(board.id)}/actions`,
        query: { since: since.toISOString(), filter: ACTION_FILTER, limit: 100 },
      });
      if (!actions.ok) throw new Error(`trello actions failed (${actions.status})`);
      const rows = Array.isArray(actions.data) ? actions.data : [];
      stats.actions += rows.length;

      const byCard = new Map<string, Action[]>();
      for (const a of rows) {
        const cardId = a.data?.card?.id;
        if (!cardId) continue;
        const list = byCard.get(cardId) ?? [];
        list.push(a);
        byCard.set(cardId, list);
      }

      for (const [cardId, cardActions] of byCard) {
        cardActions.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
        const latest = cardActions[cardActions.length - 1]!;
        let card: Card | null = null;
        if (cardFetches < MAX_CARD_FETCHES) {
          cardFetches += 1;
          card = await fetchCard(client, connectionId, cardId);
        }
        const name = card?.name ?? latest.data?.card?.name ?? cardId;
        const shortLink = latest.data?.card?.shortLink;
        signals.push({
          external_id: `card:${cardId}`,
          title: `${board.name ?? "Board"} · ${name}`,
          text: [
            `Board: ${board.name ?? board.id}${card?.closed ? " · Archived" : ""}`,
            card?.desc ? `\n${clip(card.desc, 3000)}\n` : "",
            "Recent activity:",
            ...cardActions.map(describeAction),
          ].join("\n"),
          url: card?.shortUrl ?? card?.url ?? (shortLink ? `https://trello.com/c/${shortLink}` : board.url),
          author: latest.memberCreator?.fullName ?? latest.memberCreator?.username,
          at: latest.date,
          kind_hint: "card",
        });
        stats.cards += 1;
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
