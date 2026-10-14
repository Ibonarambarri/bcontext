/**
 * Contentful — `contentful` → Nango `contentful` (OAuth2; proxy base
 * https://<subdomain>.contentful.com — the Content Management API lives on
 * the `api` subdomain, which is what the connection has to be created with).
 *
 * Entries of one space (`config.space_id`, else the first space the token
 * sees) and environment (`config.environment`, default `master`) updated
 * since the cursor, newest first:
 *   GET /spaces/{space}/environments/{env}/entries?sys.updatedAt[gte]=…&order=-sys.updatedAt&limit=100&skip=n
 * Fields are localised maps (`{ "en-US": … }`): the `en-US` value wins, else
 * the first locale. Rich text documents are flattened to their text nodes,
 * links summarised as `[link → id]`. A signal per entry with its content
 * type and publish state (draft / published / changed).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, configString, type NangoAdapter } from "./shared";

interface CfSys {
  id: string;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string;
  version?: number;
  publishedVersion?: number;
  archivedAt?: string;
  contentType?: { sys?: { id?: string } };
  updatedBy?: { sys?: { id?: string } };
  linkType?: string;
}
interface CfEntry {
  sys: CfSys;
  fields?: Record<string, Record<string, unknown>>;
}
interface CfCollection<T> {
  items?: T[];
  total?: number;
  skip?: number;
  limit?: number;
}
interface CfSpace {
  sys: { id: string };
  name?: string;
}

/** Contentful rich text (`nodeType: "document"`) → plain text. */
export function contentfulRichTextToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { nodeType?: string; value?: string; content?: unknown[]; data?: { target?: { sys?: CfSys } } };
  if (n.nodeType === "text") return n.value ?? "";
  if (n.nodeType?.startsWith("embedded-") || n.nodeType?.endsWith("-link")) {
    const inner = (n.content ?? []).map(contentfulRichTextToText).join("");
    const target = n.data?.target?.sys;
    return inner || (target?.id ? `[link → ${target.linkType ?? target.type ?? "entry"} ${target.id}]` : "");
  }
  const inner = (n.content ?? []).map(contentfulRichTextToText).join("");
  return /^(paragraph|heading-\d|list-item|blockquote|hr|table-row)$/.test(n.nodeType ?? "") ? `${inner}\n` : inner;
}

function localised(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const map = value as Record<string, unknown>;
  if ("en-US" in map) return map["en-US"];
  const first = Object.keys(map)[0];
  return first ? map[first] : undefined;
}

function valueToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(valueToText).filter(Boolean).join(", ");
  const o = value as { nodeType?: string; sys?: CfSys; lat?: number; lon?: number };
  if (o.nodeType === "document") return contentfulRichTextToText(o).trim();
  if (o.sys?.id) return `[link → ${o.sys.linkType ?? o.sys.type ?? "entry"} ${o.sys.id}]`;
  if (typeof o.lat === "number" && typeof o.lon === "number") return `${o.lat},${o.lon}`;
  return "";
}

/** Localised field map → "key: value" lines (en-US first). */
export function contentfulFieldsToText(fields: CfEntry["fields"]): string {
  const lines: string[] = [];
  for (const [key, locales] of Object.entries(fields ?? {})) {
    const text = valueToText(localised(locales)).trim();
    if (text) lines.push(`${key}: ${clip(text, 3000)}`);
  }
  return lines.join("\n");
}

export function contentfulState(sys: CfSys): "archived" | "draft" | "published" | "changed" {
  if (sys.archivedAt) return "archived";
  if (!sys.publishedAt || typeof sys.publishedVersion !== "number") return "draft";
  return typeof sys.version === "number" && sys.version > sys.publishedVersion + 1 ? "changed" : "published";
}

export function contentfulEntryTitle(entry: CfEntry): string {
  const fields = entry.fields ?? {};
  for (const key of ["title", "name", "headline", "slug"]) {
    const v = valueToText(localised(fields[key])).trim();
    if (v) return v;
  }
  const first = Object.values(fields).map((l) => valueToText(localised(l)).trim()).find(Boolean);
  return first ? clip(first, 80) : entry.sys.id;
}

export const contentfulAdapter: NangoAdapter = {
  id: "contentful",
  provider: "contentful",
  sourceHint: "contentful:entries",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    let space = configString(config, "space_id");
    if (!space) {
      const spaces = await client.proxy<CfCollection<CfSpace>>({ method: "GET", providerConfigKey: "contentful", connectionId, path: "/spaces", query: { limit: 1 } });
      if (!spaces.ok) throw new Error(`contentful spaces failed (${spaces.status})`);
      space = spaces.data?.items?.[0]?.sys.id ?? null;
    }
    const stats: Record<string, number> = {};
    if (!space) return { signals: [], stats: { missing_space: 1 } };
    const environment = configString(config, "environment") ?? "master";
    const contentTypes = allowList(config, "content_types");
    const signals: IngestSignal[] = [];
    let scanned = 0;
    for (let skip = 0; skip < 300 && signals.length < limit; skip += 100) {
      const res = await client.proxy<CfCollection<CfEntry>>({
        method: "GET",
        providerConfigKey: "contentful",
        connectionId,
        path: `/spaces/${encodeURIComponent(space)}/environments/${encodeURIComponent(environment)}/entries`,
        query: {
          "sys.updatedAt[gte]": since.toISOString(),
          order: "-sys.updatedAt",
          limit: 100,
          skip,
          ...(contentTypes?.length === 1 ? { content_type: contentTypes[0] } : {}),
        },
      });
      if (!res.ok) throw new Error(`contentful entries failed (${res.status})`);
      const items = res.data?.items ?? [];
      scanned += items.length;
      for (const entry of items) {
        const type = entry.sys.contentType?.sys?.id ?? "entry";
        if (contentTypes && !contentTypes.includes(type)) continue;
        const state = contentfulState(entry.sys);
        if (state === "archived") continue;
        signals.push({
          external_id: `entry:${entry.sys.id}`,
          title: `${type} · ${contentfulEntryTitle(entry)}`,
          text: clip([`Content type: ${type} · State: ${state}${entry.sys.publishedAt ? ` · Published: ${entry.sys.publishedAt}` : ""}`, "", contentfulFieldsToText(entry.fields)].join("\n")),
          url: `https://app.contentful.com/spaces/${space}/environments/${environment}/entries/${entry.sys.id}`,
          author: entry.sys.updatedBy?.sys?.id,
          at: entry.sys.updatedAt,
          kind_hint: "entry",
        });
        if (signals.length >= limit) break;
      }
      const total = res.data?.total ?? items.length;
      if (skip + 100 >= total || items.length < 100) break;
    }
    stats.scanned = scanned;
    return { signals: signals.slice(0, limit), stats };
  },
};
