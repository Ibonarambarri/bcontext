/**
 * Notion bulk importer (first-party OAuth integration — not through Nango).
 *
 * Two paths, both one-shot:
 *
 *   1. ZIP path — a Notion "Export → Markdown & CSV" zip goes through the
 *      generic workspace import (`/api/workspaces/[ws]/import`,
 *      `src/lib/import-md.ts`); this connector is not involved.
 *
 *   2. OAuth path — `notion.so/install` for a workspace integration.
 *      We crawl the API once on `fullSync` and never poll. Notion's
 *      rate limits are brutal: 3 req/s public, ~10 req/s undocumented.
 *      The crawler respects 429 retry-after and persists progress as
 *      `connector_jobs.payload.cursor`.
 *
 * The mapping rules:
 *   - Page → `doc` node. Title from page title.
 *   - Sub-page/database provenance remains metadata until it can reference a
 *     real semantic parent. Connector sync never creates folder nodes.
 */
import { registerConnector } from "../registry";
import type {
  Connector,
  ContextNodeInput,
  WebhookEnvelope,
  WebhookOutcome,
} from "@bcontext-dev/contract/connectors/types";
import { appUrl as configuredAppUrl } from "@/lib/env";

interface NotionPage {
  id: string;
  parent: {
    type: "workspace" | "database_id" | "page_id";
    database_id?: string;
    page_id?: string;
  };
  properties: Record<string, unknown>;
  archived?: boolean;
  url?: string;
}

const notionConnector: Connector = {
  id: "notion",

  async authorize(ctx, phase) {
    if (phase === "start") {
      const clientId = process.env.NOTION_CLIENT_ID;
      if (!clientId) return {};
      const redirect = `${appUrl()}/api/connectors/notion/callback`;
      const url = new URL("https://api.notion.com/v1/oauth/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirect);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("owner", "user");
      url.searchParams.set("state", ctx.installId);
      return { redirectUrl: url.toString() };
    }
    return {};
  },

  async fullSync(ctx, cursor) {
    if (!ctx.secret) return { processed: 0, byKind: {}, nodes: [], hasMore: false, cursor: null };
    // Search across the integration's accessible pages — Notion's
    // /v1/search is the most efficient crawl entry point.
    const page = await searchPages(ctx.secret, cursor ?? null);
    const nodes: ContextNodeInput[] = page.results.map(pageToNode);
    return {
      processed: nodes.length,
      byKind: countByKind(nodes),
      nodes,
      hasMore: page.has_more ?? false,
      cursor: page.next_cursor ?? null,
    };
  },

  // Notion's webhooks are an "integration event subscription" beta and
  // unreliable for bulk import use cases. Per spec we treat this as a
  // one-shot importer — no webhook handling.
  async handleWebhook(
    _ctx,
    _envelope: WebhookEnvelope,
  ): Promise<WebhookOutcome> {
    return { nodes: [], audit: "notion.no_webhooks" };
  },

  toContextNode(_ctx, entity) {
    return pageToNode(entity as unknown as NotionPage);
  },
};

registerConnector(notionConnector);

// -- API search -------------------------------------------------------------

interface NotionSearchResponse {
  results: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
}

async function searchPages(
  token: string,
  cursor: string | null,
): Promise<NotionSearchResponse> {
  const res = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({
      page_size: 50,
      start_cursor: cursor ?? undefined,
      filter: { property: "object", value: "page" },
    }),
  });
  if (!res.ok) return { results: [], has_more: false, next_cursor: null };
  return (await res.json()) as NotionSearchResponse;
}

function pageToNode(page: NotionPage): ContextNodeInput {
  const title = extractTitle(page);
  return {
    source: "notion",
    external_id: `page:${page.id}`,
    kind: "doc",
    title: title ?? "Untitled Notion page",
    content_md: "_Imported from Notion. Block contents not fetched in v1 — open the linked URL for the full body._",
    data: {
      notion_id: page.id,
      parent: page.parent,
      url: page.url ?? null,
    },
  };
}

function extractTitle(page: NotionPage): string | null {
  for (const value of Object.values(page.properties)) {
    if (!value || typeof value !== "object") continue;
    const v = value as { type?: string; title?: Array<{ plain_text?: string }> };
    if (v.type === "title" && Array.isArray(v.title)) {
      const text = v.title.map((t) => t.plain_text ?? "").join("");
      if (text) return text;
    }
  }
  return null;
}

function countByKind(nodes: ContextNodeInput[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of nodes) out[n.kind] = (out[n.kind] ?? 0) + 1;
  return out;
}

function appUrl(): string {
  return (
    configuredAppUrl() ?? "http://localhost:3000"
  );
}

export { notionConnector };
