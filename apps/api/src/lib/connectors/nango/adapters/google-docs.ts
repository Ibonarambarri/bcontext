/**
 * Google Docs — `google-docs` → Nango `google-docs` (OAuth2 via `google`;
 * proxy base https://docs.googleapis.com).
 *
 * Deliberately minimal. The Docs API has no "list documents" and no
 * modified-time, so this adapter reads the documents the workspace pins in
 * `config.document_ids` and emits a signal keyed by `revisionId` — an
 * unchanged document produces the same signal and is deduped downstream.
 * **The recommended path for "documents that changed" is the Google Drive
 * connector**, which lists by `modifiedTime` and exports Docs as text.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface DocsTextRun { textRun?: { content?: string } }
interface DocsParagraph { elements?: DocsTextRun[] }
interface DocsStructuralElement { paragraph?: DocsParagraph; table?: { tableRows?: Array<{ tableCells?: Array<{ content?: DocsStructuralElement[] }> }> } }
interface DocsDocument {
  documentId?: string;
  title?: string;
  revisionId?: string;
  body?: { content?: DocsStructuralElement[] };
}

/** Walk the document body in order, paragraphs and table cells included. */
export function docsToText(content: DocsStructuralElement[] | undefined): string {
  const out: string[] = [];
  for (const el of content ?? []) {
    if (el.paragraph) {
      out.push((el.paragraph.elements ?? []).map((e) => e.textRun?.content ?? "").join(""));
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        out.push((row.tableCells ?? []).map((cell) => docsToText(cell.content).trim()).join(" | "));
      }
    }
  }
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

export const googleDocsAdapter: NangoAdapter = {
  id: "google-docs",
  provider: "google-docs",
  sourceHint: "google-docs:documents",
  async fetchChanges({ client, connectionId, config, limit }) {
    const ids = allowList(config, "document_ids") ?? [];
    const signals: IngestSignal[] = [];
    let missing = 0;
    for (const id of ids.slice(0, Math.min(limit, 20))) {
      const res = await client.proxy<DocsDocument>({
        method: "GET",
        providerConfigKey: "google-docs",
        connectionId,
        path: `/v1/documents/${encodeURIComponent(id)}`,
      });
      if (!res.ok || !res.data) {
        missing += 1;
        continue;
      }
      const doc = res.data;
      signals.push({
        external_id: `document:${doc.documentId ?? id}:${doc.revisionId ?? "0"}`,
        title: doc.title ?? id,
        text: clip(docsToText(doc.body?.content)),
        url: `https://docs.google.com/document/d/${encodeURIComponent(doc.documentId ?? id)}/edit`,
        kind_hint: "document",
      });
    }
    return { signals, stats: { configured: ids.length, missing } };
  },
};
