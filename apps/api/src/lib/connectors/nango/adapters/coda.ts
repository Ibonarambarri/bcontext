/**
 * Coda — `coda` → Nango `coda` (API_KEY; proxy base https://coda.io/apis/v1).
 * Docs the token can see (`/docs`, `updatedAt` after the cursor, or the
 * `config.doc_ids` pins), then the pages of each changed doc
 * (`/docs/{id}/pages`, again by `updatedAt`). One signal per changed page.
 *
 * Page bodies are only available through the export flow (`POST
 * …/pages/{id}/export` → poll → download from a signed URL on another
 * host), which the proxy cannot follow, so the signal carries the page
 * name, subtitle and browser link; NEXO learns *what* moved and where to
 * look. Doc-level signals are emitted for docs with no page listing.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, type NangoAdapter } from "./shared";

interface CodaDoc {
  id: string;
  name?: string;
  browserLink?: string;
  updatedAt?: string;
  owner?: string;
  ownerName?: string;
  workspace?: { name?: string };
  folder?: { name?: string };
}

interface CodaPage {
  id: string;
  name?: string;
  subtitle?: string;
  browserLink?: string;
  updatedAt?: string;
  contentType?: string;
  parent?: { name?: string };
}

interface CodaList<T> {
  items?: T[];
  nextPageToken?: string;
}

const MAX_DOCS = 25;
const MAX_PAGE_REQUESTS = 3;

export const codaAdapter: NangoAdapter = {
  id: "coda",
  provider: "coda",
  sourceHint: "coda:pages",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const pinned = allowList(config, "doc_ids");
    const docs: CodaDoc[] = [];

    if (pinned) {
      for (const id of pinned.slice(0, MAX_DOCS)) {
        const res = await client.proxy<CodaDoc>({
          method: "GET",
          providerConfigKey: "coda",
          connectionId,
          path: `/docs/${encodeURIComponent(id)}`,
        });
        if (!res.ok) throw new Error(`coda doc ${id} failed (${res.status})`);
        if (res.data?.id) docs.push(res.data);
      }
    } else {
      let pageToken: string | undefined;
      let requests = 0;
      do {
        const res = await client.proxy<CodaList<CodaDoc>>({
          method: "GET",
          providerConfigKey: "coda",
          connectionId,
          path: "/docs",
          query: { isOwner: false, limit: 100, ...(pageToken ? { pageToken } : {}) },
        });
        if (!res.ok) throw new Error(`coda docs failed (${res.status})`);
        for (const d of res.data?.items ?? []) {
          if (d.updatedAt && new Date(d.updatedAt) > since) docs.push(d);
        }
        pageToken = res.data?.nextPageToken;
        requests++;
      } while (pageToken && requests < MAX_PAGE_REQUESTS && docs.length < MAX_DOCS);
    }

    const signals: IngestSignal[] = [];
    const stats = { docs: docs.length, pages: 0 };

    for (const doc of docs.slice(0, MAX_DOCS)) {
      const where = [doc.workspace?.name, doc.folder?.name].filter(Boolean).join(" / ");
      let pagesSeen = 0;
      let pageToken: string | undefined;
      let requests = 0;
      do {
        const res = await client.proxy<CodaList<CodaPage>>({
          method: "GET",
          providerConfigKey: "coda",
          connectionId,
          path: `/docs/${encodeURIComponent(doc.id)}/pages`,
          query: { limit: 100, ...(pageToken ? { pageToken } : {}) },
        });
        if (!res.ok) throw new Error(`coda pages of ${doc.id} failed (${res.status})`);
        for (const p of res.data?.items ?? []) {
          if (!p.updatedAt || new Date(p.updatedAt) <= since) continue;
          pagesSeen++;
          signals.push({
            external_id: `page:${doc.id}:${p.id}`,
            title: `${doc.name ?? "Coda doc"} · ${p.name ?? "Page"}`.trim(),
            text: [
              `Doc: ${doc.name ?? doc.id}${where ? ` (${where})` : ""}`,
              p.parent?.name ? `Parent page: ${p.parent.name}` : null,
              p.subtitle ? `Subtitle: ${p.subtitle}` : null,
              p.contentType ? `Type: ${p.contentType}` : null,
              `Updated: ${p.updatedAt}`,
              "\n(Page body is not exported; open the link for the content.)",
            ]
              .filter(Boolean)
              .join("\n"),
            url: p.browserLink ?? doc.browserLink,
            author: doc.ownerName ?? doc.owner,
            at: p.updatedAt,
            kind_hint: "page",
          });
          if (signals.length >= limit) break;
        }
        pageToken = res.data?.nextPageToken;
        requests++;
      } while (pageToken && requests < MAX_PAGE_REQUESTS && signals.length < limit);

      stats.pages += pagesSeen;
      if (pagesSeen === 0 && doc.updatedAt && new Date(doc.updatedAt) > since && signals.length < limit) {
        signals.push({
          external_id: `doc:${doc.id}`,
          title: doc.name ?? `Coda doc ${doc.id}`,
          text: `Doc updated${where ? ` in ${where}` : ""} at ${doc.updatedAt} (no page-level change listed).`,
          url: doc.browserLink,
          author: doc.ownerName ?? doc.owner,
          at: doc.updatedAt,
          kind_hint: "doc",
        });
      }
      if (signals.length >= limit) break;
    }

    return { signals: signals.slice(0, limit), stats };
  },
};
