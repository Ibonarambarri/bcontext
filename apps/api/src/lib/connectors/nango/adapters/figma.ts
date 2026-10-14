/**
 * Figma — `figma` → Nango `figma` (OAuth2; proxy base https://api.figma.com).
 * Files modified since the cursor and new comments on them, in the projects
 * of one team (`config.team_id`, required: the REST API has no "my teams"
 * listing) or on pinned files (`config.file_keys`). One signal per file that
 * changed or received comments, carrying the new comments as text — that is
 * where design decisions get written down.
 *
 * Assumptions: `/v1/teams/{id}/projects` → `{ projects }`,
 * `/v1/projects/{id}/files` → `{ files: [{ key, name, last_modified }] }`,
 * `/v1/files/{key}/comments` → `{ comments: [{ message, created_at, user,
 * resolved_at }] }` (all comments; filtered client-side by `created_at`).
 * Comment calls are capped to 40 files per run.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, configString, type NangoAdapter } from "./shared";

interface FigmaProject {
  id: string | number;
  name?: string;
}
interface FigmaFile {
  key: string;
  name?: string;
  last_modified?: string;
}
interface FigmaComment {
  id: string;
  message?: string;
  created_at?: string;
  resolved_at?: string | null;
  user?: { handle?: string };
}

const MAX_PROJECTS = 20;
const MAX_COMMENT_FETCHES = 40;

export function figmaFileUrl(key: string): string {
  return `https://www.figma.com/file/${key}`;
}

export const figmaAdapter: NangoAdapter = {
  id: "figma",
  provider: "figma",
  sourceHint: "figma:files",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const get = <T>(path: string) => client.proxy<T>({ method: "GET", providerConfigKey: "figma", connectionId, path });

    const files: Array<FigmaFile & { project?: string }> = [];
    const pinned = allowList(config, "file_keys");
    if (pinned) {
      for (const key of pinned) files.push({ key });
    }
    const teamId = configString(config, "team_id");
    if (teamId) {
      const projects = await get<{ projects?: FigmaProject[] }>(`/v1/teams/${encodeURIComponent(teamId)}/projects`);
      if (!projects.ok) throw new Error(`figma projects failed (${projects.status})`);
      for (const project of (projects.data?.projects ?? []).slice(0, MAX_PROJECTS)) {
        const res = await get<{ files?: FigmaFile[] }>(`/v1/projects/${encodeURIComponent(String(project.id))}/files`);
        if (!res.ok) throw new Error(`figma project files failed (${res.status})`);
        for (const f of res.data?.files ?? []) files.push({ ...f, project: project.name });
      }
    }
    if (!pinned && !teamId) return { signals: [], stats: { files: 0, comment_fetches: 0, skipped_no_team: 1 } };

    const signals: IngestSignal[] = [];
    let commentFetches = 0;
    for (const f of files) {
      if (signals.length >= limit) break;
      const modified = !!f.last_modified && new Date(f.last_modified) > since;
      // Pinned files carry no last_modified: always look at their comments.
      let fresh: FigmaComment[] = [];
      if (commentFetches < MAX_COMMENT_FETCHES && (modified || !f.last_modified)) {
        commentFetches += 1;
        const c = await get<{ comments?: FigmaComment[] }>(`/v1/files/${encodeURIComponent(f.key)}/comments`);
        if (c.ok) fresh = (c.data?.comments ?? []).filter((x) => x.created_at && new Date(x.created_at) > since);
      }
      if (!modified && fresh.length === 0) continue;
      const latestComment = fresh.map((x) => x.created_at ?? "").sort().at(-1);
      signals.push({
        external_id: `file:${f.key}`,
        title: `${f.name ?? f.key}${f.project ? ` (${f.project})` : ""}`,
        text: [
          modified ? `File modified at ${f.last_modified}.` : "File unchanged; new comments only.",
          fresh.length
            ? `\nNew comments:\n${fresh
                .slice(0, 20)
                .map((x) => `- ${x.user?.handle ?? "someone"} (${x.created_at ?? ""})${x.resolved_at ? " [resolved]" : ""}: ${clip(x.message ?? "", 1500)}`)
                .join("\n")}`
            : "",
        ].join("\n"),
        url: figmaFileUrl(f.key),
        author: fresh[0]?.user?.handle,
        at: [f.last_modified, latestComment].filter(Boolean).sort().at(-1),
        kind_hint: "design_file",
      });
    }
    return { signals: signals.slice(0, limit), stats: { files: files.length, comment_fetches: commentFetches, skipped_no_team: 0 } };
  },
};
