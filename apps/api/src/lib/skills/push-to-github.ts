/**
 * Push-side wiring: commit generated AGENTS.md / CLAUDE.md /
 * .cursor/rules/bcontext.mdc / .clinerules to the workspace's linked GitHub
 * repos whenever a skill node changes.
 *
 * Flow:
 *   1. Caller (node-update path or a manual trigger) calls `pushSkillExports`.
 *   2. We resolve the GitHub connector install for the workspace and
 *      mint a fresh, short-lived installation token.
 *   3. We read the workspace's repo allowlist from
 *      `connector_installs.config.repo_allowlist[]` (or fall back to all
 *      repos accessible to the App install).
 *   4. We generate the four files via `generate()` from `lib/skills/generate`.
 *   5. We commit each file to the default branch via `pushFileToRepo`.
 *
 * Failures are logged but never thrown — agents-md push is a
 * convenience, not a critical path.
 */
import { extractSkills, generate } from "./generate";
import {
  githubInstallationId,
  pushFileToRepo,
  refreshInstallationToken,
} from "@/lib/connectors/github";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Storage } from "@/lib/storage";
import { log } from "@bcontext-dev/contract/log";

interface InstallRow {
  id: string;
  config: Record<string, unknown>;
  status: string;
}

export interface PushResult {
  ok: boolean;
  reason?: string;
  pushed: Array<{ repo: string; path: string; sha: string | null }>;
}

const TARGETS: Array<{ format: "agents-md" | "claude-md" | "cursor-rules" | "cline-rules"; path: string }> = [
  { format: "agents-md", path: "AGENTS.md" },
  { format: "claude-md", path: "CLAUDE.md" },
  { format: "cursor-rules", path: ".cursor/rules/bcontext.mdc" },
  { format: "cline-rules", path: ".clinerules" },
];

/** Steps 1–5 above for one workspace; a workspace without a GitHub install is a no-op. */
export async function pushSkillExports(opts: {
  workspaceId: string;
  workspaceName?: string;
  storage: Storage;
}): Promise<PushResult> {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("connector_installs")
    .select("id, config, status")
    .eq("workspace_id", opts.workspaceId)
    .eq("connector_id", "github")
    .maybeSingle();
  const install = data as InstallRow | null;
  if (!install) return { ok: false, reason: "github_not_installed", pushed: [] };
  if (install.status !== "active") {
    return { ok: false, reason: `install_${install.status}`, pushed: [] };
  }

  const installationId = githubInstallationId(install.config);
  if (!installationId) {
    return { ok: false, reason: "installation_id_missing", pushed: [] };
  }
  const refreshed = await refreshInstallationToken({
    workspaceId: opts.workspaceId,
    installId: install.id,
    installationId,
  });
  if (!refreshed) {
    return { ok: false, reason: "token_refresh_failed", pushed: [] };
  }
  const token = refreshed.token;

  const repos = (install.config.repo_allowlist as string[] | undefined) ?? [];
  if (repos.length === 0) {
    return { ok: false, reason: "no_repos_allowlisted", pushed: [] };
  }

  const nodes = await opts.storage.listNodes();
  const skills = extractSkills(nodes);
  if (skills.length === 0) {
    return { ok: false, reason: "no_skill_nodes", pushed: [] };
  }

  const pushed: PushResult["pushed"] = [];
  for (const repo of repos) {
    for (const target of TARGETS) {
      const content = generate(target.format, skills, {
        workspaceName: opts.workspaceName,
      });
      const sha = await pushFileToRepo({
        token,
        repo,
        path: target.path,
        message: `chore(bcontext): sync ${target.path} from skill nodes`,
        content,
      });
      pushed.push({ repo, path: target.path, sha });
      if (!sha) {
        log.warn("skills.push.failed", {
          workspace_id: opts.workspaceId,
          repo,
          path: target.path,
        });
      }
    }
  }

  log.info("skills.push.done", {
    workspace_id: opts.workspaceId,
    repos: repos.length,
    files: pushed.length,
    successes: pushed.filter((p) => p.sha).length,
  });

  return { ok: true, pushed };
}
