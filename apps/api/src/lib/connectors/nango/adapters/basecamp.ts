/**
 * Basecamp — `basecamp` → Nango `basecamp` (OAuth2; proxy base
 * https://3.basecampapi.com/${connectionConfig.accountId}, Nango sets the
 * User-Agent Basecamp demands). `/projects.json` (or `config.projects`,
 * ids or names), then the cross-project recordings endpoint per type —
 * `/projects/recordings.json?type=Message|Todo|Document|Comment&bucket=…
 * &sort=updated_at&direction=desc` — read newest first until the first
 * recording older than the cursor (first page only per type, Basecamp
 * pages with a Link header the proxy does not surface). One signal per
 * recording: HTML content flattened, creator, project, parent thread.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, htmlToText, type NangoAdapter } from "./shared";

interface BasecampProject {
  id: number;
  name?: string;
  app_url?: string;
  status?: string;
}

interface BasecampRecording {
  id: number;
  type?: string;
  status?: string;
  title?: string;
  content?: string | null;
  description?: string | null;
  app_url?: string;
  created_at?: string;
  updated_at?: string;
  completed?: boolean;
  due_on?: string | null;
  assignees?: Array<{ name?: string }>;
  creator?: { name?: string; email_address?: string };
  bucket?: { id?: number; name?: string };
  parent?: { title?: string; type?: string; app_url?: string };
}

export const BASECAMP_TYPES = ["Message", "Todo", "Document", "Comment"] as const;
const MAX_PROJECTS = 20;

export const basecampAdapter: NangoAdapter = {
  id: "basecamp",
  provider: "basecamp",
  sourceHint: "basecamp:recordings",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const wanted = allowList(config, "projects");
    const listed = await client.proxy<BasecampProject[]>({
      method: "GET",
      providerConfigKey: "basecamp",
      connectionId,
      path: "/projects.json",
    });
    if (!listed.ok) throw new Error(`basecamp projects failed (${listed.status})`);
    const projects = (Array.isArray(listed.data) ? listed.data : [])
      .filter((p) => !wanted || wanted.includes(String(p.id)) || (p.name != null && wanted.includes(p.name)))
      .slice(0, MAX_PROJECTS);
    const names = new Map(projects.map((p) => [p.id, p.name ?? String(p.id)]));
    if (!projects.length) return { signals: [], stats: { projects: 0, recordings: 0 } };

    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { projects: projects.length, recordings: 0 };
    for (const type of BASECAMP_TYPES) {
      const res = await client.proxy<BasecampRecording[]>({
        method: "GET",
        providerConfigKey: "basecamp",
        connectionId,
        path: "/projects/recordings.json",
        query: { type, bucket: projects.map((p) => p.id).join(","), sort: "updated_at", direction: "desc" },
      });
      if (!res.ok) throw new Error(`basecamp recordings ${type} failed (${res.status})`);
      const rows = Array.isArray(res.data) ? res.data : [];
      let kept = 0;
      for (const r of rows) {
        if (r.updated_at && new Date(r.updated_at) <= since) break;
        kept++;
        const body = htmlToText(r.content ?? r.description ?? "");
        const project = (r.bucket?.id != null && names.get(r.bucket.id)) || r.bucket?.name;
        const assignees = (r.assignees ?? []).map((a) => a.name).filter(Boolean).join(", ");
        signals.push({
          external_id: `${type.toLowerCase()}:${r.id}`,
          title: `${r.title ?? (r.parent?.title ? `Re: ${r.parent.title}` : type)}${project ? ` · ${project}` : ""}`,
          text: clip(
            [
              `Type: ${type}${r.status ? ` · Status: ${r.status}` : ""}${type === "Todo" ? ` · ${r.completed ? "completed" : "open"}${r.due_on ? ` · due ${r.due_on}` : ""}` : ""}`,
              assignees ? `Assignees: ${assignees}` : null,
              r.parent?.title ? `In: ${r.parent.title}${r.parent.type ? ` (${r.parent.type})` : ""}` : null,
              "",
              body,
            ]
              .filter((x) => x !== null)
              .join("\n"),
          ),
          url: r.app_url,
          author: r.creator?.name ?? r.creator?.email_address,
          at: r.updated_at ?? r.created_at,
          kind_hint: type.toLowerCase(),
        });
        if (signals.length >= limit) break;
      }
      stats[type.toLowerCase()] = kept;
      stats.recordings = (stats.recordings ?? 0) + kept;
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
