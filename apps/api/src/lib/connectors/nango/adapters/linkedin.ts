/**
 * LinkedIn — `linkedin` → Nango `linkedin` (OAuth2; the integration needs the
 * Community Management API product with `r_organization_social`). Posts
 * authored by the organisation in `config.organization_id`, newest modified
 * first (`GET /rest/posts?q=author&sortBy=LAST_MODIFIED`), kept while
 * `lastModifiedAt > since`; the first few posts also carry their latest
 * comments (`GET /rest/socialActions/{urn}/comments`). Without an
 * organisation id there is nothing to read (member posts need another
 * product), so the run returns zero signals and a stats hint.
 *
 * Assumptions (docs, not exercised live): versioned headers
 * `LinkedIn-Version: 202409` + `X-Restli-Protocol-Version: 2.0.0`; post
 * fields `id`, `commentary`, `createdAt`, `lastModifiedAt` (ms),
 * `lifecycleState`; comments under `elements[].message.text`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, configString, type NangoAdapter } from "./shared";

export const LINKEDIN_HEADERS = { "LinkedIn-Version": "202409", "X-Restli-Protocol-Version": "2.0.0" } as const;

interface LiPost {
  id: string;
  commentary?: string;
  createdAt?: number;
  lastModifiedAt?: number;
  publishedAt?: number;
  lifecycleState?: string;
  visibility?: string;
  content?: { article?: { title?: string; source?: string }; media?: { title?: string } };
}

interface LiComment {
  id?: string;
  message?: { text?: string };
  actor?: string;
  created?: { time?: number };
}

interface LiPage<T> {
  elements?: T[];
  paging?: { start?: number; count?: number; total?: number };
}

const COMMENT_LIMIT = 10;
const DETAIL_LIMIT = 10;

function iso(ms?: number): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function postUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}`;
}

export const linkedinAdapter: NangoAdapter = {
  id: "linkedin",
  provider: "linkedin",
  sourceHint: "linkedin:organization-posts",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const organizationId = configString(config, "organization_id");
    if (!organizationId) return { signals: [], stats: { missing_organization_id: 1 } as Record<string, number> };
    const author = `urn:li:organization:${organizationId}`;
    const res = await client.proxy<LiPage<LiPost>>({
      method: "GET",
      providerConfigKey: "linkedin",
      connectionId,
      path: "/rest/posts",
      query: { q: "author", author, count: Math.min(50, limit), sortBy: "LAST_MODIFIED" },
      headers: { ...LINKEDIN_HEADERS },
    });
    if (!res.ok) throw new Error(`linkedin posts failed (${res.status})`);

    const signals: IngestSignal[] = [];
    let detailed = 0;
    for (const p of res.data?.elements ?? []) {
      const modified = p.lastModifiedAt ?? p.publishedAt ?? p.createdAt;
      if (typeof modified === "number" && modified <= since.getTime()) break;
      const lines = [
        `State: ${p.lifecycleState ?? "?"}${p.visibility ? ` · Visibility: ${p.visibility}` : ""}`,
        p.content?.article?.title ? `Article: ${p.content.article.title}${p.content.article.source ? ` (${p.content.article.source})` : ""}` : null,
        "",
        (p.commentary ?? "").trim(),
      ].filter((x): x is string => x !== null);
      if (detailed < DETAIL_LIMIT) {
        detailed += 1;
        const comments = await client.proxy<LiPage<LiComment>>({
          method: "GET",
          providerConfigKey: "linkedin",
          connectionId,
          path: `/rest/socialActions/${encodeURIComponent(p.id)}/comments`,
          query: { count: COMMENT_LIMIT },
          headers: { ...LINKEDIN_HEADERS },
        });
        const list = comments.ok ? comments.data?.elements ?? [] : [];
        if (list.length) {
          lines.push("", "Comments:");
          for (const c of list.slice(0, COMMENT_LIMIT)) {
            lines.push(`- ${c.actor ?? "someone"} (${iso(c.created?.time) ?? ""}): ${clip(c.message?.text ?? "", 800)}`);
          }
        }
      }
      const firstLine = (p.commentary ?? "").split("\n").find((l) => l.trim()) ?? "";
      signals.push({
        external_id: `post:${p.id}`,
        title: clip(firstLine || p.content?.article?.title || `Post ${p.id}`, 140),
        text: clip(lines.join("\n")),
        url: postUrl(p.id),
        author,
        at: iso(modified),
        kind_hint: "post",
      });
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats: { posts: signals.length, detailed } };
  },
};
