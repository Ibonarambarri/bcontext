/**
 * Canva — `canva` → Nango `canva` (OAuth2; proxy base https://api.canva.com).
 *
 * Connect API `GET /rest/v1/designs?ownership=any&sort_by=modified_descending`
 * (continuation-paged, ≤ 5 pages), kept while `updated_at` (unix seconds) is
 * after the cursor. Then `GET /rest/v1/designs/{id}` for the first ≤ 20 to
 * pick up `page_count`/`created_at` (failure tolerated). The Connect API has
 * no comments endpoint, so a signal is the design's metadata: what changed,
 * when, by which team, with the view link. Scopes: design:meta:read.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { epochSeconds, type NangoAdapter } from "./shared";

interface CanvaDesign {
  id: string;
  title?: string | null;
  created_at?: number;
  updated_at?: number;
  page_count?: number;
  owner?: { user_id?: string; team_id?: string };
  urls?: { edit_url?: string; view_url?: string };
  thumbnail?: { url?: string };
}

interface ListResponse {
  items?: CanvaDesign[];
  continuation?: string;
}

const MAX_PAGES = 5;
const DETAILS_FOR = 20;

function iso(seconds: number | undefined): string | undefined {
  return typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;
}

export const canvaAdapter: NangoAdapter = {
  id: "canva",
  provider: "canva",
  sourceHint: "canva:designs",
  async fetchChanges({ client, connectionId, since, limit }) {
    const sinceSeconds = epochSeconds(since);
    const fresh: CanvaDesign[] = [];
    let continuation: string | undefined;
    let pages = 0;
    let exhausted = false;
    do {
      const res = await client.proxy<ListResponse>({
        method: "GET",
        providerConfigKey: "canva",
        connectionId,
        path: "/rest/v1/designs",
        query: { ownership: "any", sort_by: "modified_descending", limit: 50, ...(continuation ? { continuation } : {}) },
      });
      if (!res.ok) throw new Error(`canva designs failed (${res.status})`);
      pages++;
      for (const d of res.data?.items ?? []) {
        if (typeof d.updated_at === "number" && d.updated_at <= sinceSeconds) {
          exhausted = true; // newest-modified first
          continue;
        }
        fresh.push(d);
      }
      continuation = res.data?.continuation;
    } while (continuation && !exhausted && pages < MAX_PAGES && fresh.length < limit);

    const signals: IngestSignal[] = [];
    for (const [i, listed] of fresh.slice(0, limit).entries()) {
      let d = listed;
      if (i < DETAILS_FOR) {
        const det = await client.proxy<{ design?: CanvaDesign }>({
          method: "GET",
          providerConfigKey: "canva",
          connectionId,
          path: `/rest/v1/designs/${encodeURIComponent(listed.id)}`,
        });
        if (det.ok && det.data?.design) d = { ...listed, ...det.data.design };
      }
      const updated = iso(d.updated_at);
      signals.push({
        external_id: `design:${d.id}`,
        title: d.title?.trim() || `Untitled design ${d.id}`,
        text: [
          `Updated: ${updated ?? "?"}${d.created_at ? ` · Created: ${iso(d.created_at)}` : ""}`,
          typeof d.page_count === "number" ? `Pages: ${d.page_count}` : null,
          d.owner?.team_id ? `Team: ${d.owner.team_id}` : null,
          d.urls?.view_url ? `View: ${d.urls.view_url}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        url: d.urls?.view_url ?? d.urls?.edit_url,
        author: d.owner?.user_id,
        at: updated,
        kind_hint: "design",
      });
    }
    return { signals, stats: { pages, designs: fresh.length } };
  },
};
