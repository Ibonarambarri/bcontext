/**
 * Google Slides — `google-slides` → Nango `google-slides` (OAuth2 via
 * google; proxy base https://slides.googleapis.com, Slides API v1).
 *
 * Like Sheets, the Slides API cannot list presentations or say when one
 * changed — that is Drive's job (the `google-drive` connector exports
 * Slides as text when a folder is watched). This is the "pinned decks"
 * path: `config.presentation_ids` names the decks NEXO keeps reading; each
 * run fetches every deck once (`GET /v1/presentations/{id}` with a `fields`
 * mask) and emits one signal per presentation: slide by slide, the text of
 * shapes and tables plus the speaker notes, capped at 20 KB. Without
 * `presentation_ids` it does nothing.
 *
 * `at` is the cursor instant (no modified time in the Slides API); dedupe
 * happens on the stable external_id.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

const KEY = "google-slides";
const FIELDS =
  "title,slides(objectId,pageElements(shape(placeholder,text(textElements(textRun(content)))),table(tableRows(tableCells(text(textElements(textRun(content))))))),slideProperties(notesPage(pageElements(shape(placeholder,text(textElements(textRun(content))))))))";

interface TextBody {
  textElements?: Array<{ textRun?: { content?: string } }>;
}
interface PageElement {
  shape?: { placeholder?: { type?: string }; text?: TextBody };
  table?: { tableRows?: Array<{ tableCells?: Array<{ text?: TextBody }> }> };
}
interface Slide {
  objectId?: string;
  pageElements?: PageElement[];
  slideProperties?: { notesPage?: { pageElements?: PageElement[] } };
}
export interface Presentation {
  title?: string;
  slides?: Slide[];
}

function bodyText(body: TextBody | undefined): string {
  return (body?.textElements ?? [])
    .map((e) => e.textRun?.content ?? "")
    .join("")
    .replace(//g, "\n")
    .trim();
}

function elementsText(elements: PageElement[] | undefined, opts: { notes?: boolean } = {}): string {
  const parts: string[] = [];
  for (const el of elements ?? []) {
    if (el.shape) {
      if (opts.notes && el.shape.placeholder?.type !== "BODY") continue;
      const t = bodyText(el.shape.text);
      if (t) parts.push(t);
    }
    for (const row of el.table?.tableRows ?? []) {
      const cells = (row.tableCells ?? []).map((c) => bodyText(c.text).replace(/\n/g, " "));
      if (cells.some(Boolean)) parts.push(cells.join(" | "));
    }
  }
  return parts.join("\n");
}

/** Presentation → "Slide N: …" blocks with speaker notes. */
export function presentationToText(p: Presentation): string {
  const out: string[] = [];
  (p.slides ?? []).forEach((slide, i) => {
    const body = elementsText(slide.pageElements);
    const notes = elementsText(slide.slideProperties?.notesPage?.pageElements, { notes: true });
    if (!body && !notes) return;
    out.push(`Slide ${i + 1}:${body ? `\n${body}` : ""}${notes ? `\nNotes: ${notes}` : ""}`);
  });
  return out.join("\n\n");
}

export const googleSlidesAdapter: NangoAdapter = {
  id: KEY,
  provider: "google-slides",
  sourceHint: "google-slides:presentations",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const ids = allowList(config, "presentation_ids");
    if (!ids) return { signals: [], stats: { presentations: 0, note_no_presentation_ids: 1 } };
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { presentations: 0, skipped: 0 };
    for (const id of ids.slice(0, 20)) {
      const res = await client.proxy<Presentation>({
        method: "GET",
        providerConfigKey: KEY,
        connectionId,
        path: `/v1/presentations/${encodeURIComponent(id)}`,
        query: { fields: FIELDS },
      });
      if (!res.ok || !res.data) {
        stats.skipped = (stats.skipped ?? 0) + 1;
        continue;
      }
      const text = presentationToText(res.data);
      if (!text) continue;
      stats.presentations = (stats.presentations ?? 0) + 1;
      signals.push({
        external_id: `presentation:${id}`,
        title: res.data.title ?? id,
        text: clip(`Deck: ${res.data.title ?? id} · ${res.data.slides?.length ?? 0} slides\n\n${text}`, 20_000),
        url: `https://docs.google.com/presentation/d/${id}/edit`,
        at: since.toISOString(),
        kind_hint: "presentation",
      });
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
