/**
 * Generate AGENTS.md / CLAUDE.md / .cursor/rules / .clinerules from the
 * skill nodes in a workspace.
 *
 * A "skill node" is any node whose `content_md` opens with a SKILL.md
 * frontmatter block — the same shape Anthropic Agent Skills uses:
 *
 *   ---
 *   name: weekly_review
 *   description: Generate a weekly recap covering shipped, ...
 *   ---
 *
 *   <prompt body>
 *
 * The `skill` node kind is the canonical home for skill-shaped
 * nodes, but the generator filters by frontmatter rather than kind so it
 * stays backwards-compatible with older skill-shaped doc nodes. Callers that want strict scoping
 * can pre-filter `nodes` to `kind === "skill"` before passing them in.
 */
import matter from "gray-matter";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";

export type Format = "agents-md" | "claude-md" | "cursor-rules" | "cline-rules";

export interface Skill {
  /** Frontmatter `name` field. */
  name: string;
  /** Frontmatter `description` field. */
  description: string;
  /** Raw body after the frontmatter. */
  body: string;
  /** Source node id (for traceability + GitHub commit links later). */
  source_id: string;
}

/** Skill-shaped nodes (frontmatter with `name`) out of any node list, in input order. */
export function extractSkills(nodes: readonly KnowledgeNode[]): Skill[] {
  const out: Skill[] = [];
  for (const node of nodes) {
    const skill = parseSkillNode(node);
    if (skill) out.push(skill);
  }
  return out;
}

/** One node → `Skill`, or null when it has no frontmatter `name` (not a skill). */
export function parseSkillNode(
  node: Pick<KnowledgeNode, "id" | "title" | "content_md">,
): Skill | null {
  const md = node.content_md ?? "";
  if (!md.startsWith("---")) return null;
  try {
    const parsed = matter(md);
    const fm = parsed.data as Record<string, unknown>;
    const name = typeof fm.name === "string" ? fm.name.trim() : "";
    if (!name) return null;
    const description =
      typeof fm.description === "string" ? fm.description.trim() : node.title;
    return {
      name,
      description,
      body: parsed.content.trim(),
      source_id: node.id,
    };
  } catch {
    return null;
  }
}

/** Renders the skill set in one of the four agent-rules formats. */
export function generate(
  format: Format,
  skills: readonly Skill[],
  opts?: { workspaceName?: string },
): string {
  switch (format) {
    case "agents-md":
      return renderAgentsMd(skills, opts);
    case "claude-md":
      return renderClaudeMd(skills, opts);
    case "cursor-rules":
      return renderCursorRules(skills);
    case "cline-rules":
      return renderClineRules(skills);
  }
}

/**
 * How-to-behave preamble shared by AGENTS.md and CLAUDE.md. The
 * generated rules pack is what downstream agents read first, so the working
 * conventions live here — not in a doc humans read and agents never see.
 */
function renderAgentPreamble(): string {
  return [
    "## Working with Bcontext",
    "",
    "**Connect over MCP.** Bcontext exposes one agent surface: a Streamable HTTP MCP server at `<BCONTEXT_URL>/mcp`, authenticated with a workspace-scoped bearer token (or OAuth, discovered from `/.well-known/oauth-protected-resource`). Tools appear as `mcp__bcontext__*`.",
    "",
    "- Orient: `ask_rag({ question })` — synthesized answer, every claim cited `[N]`, sources as `/n/<id>#<block>` refs. `nodes({ op: \"search\" })`, `nodes({ op: \"list\" })`, and `nodes({ op: \"list\", unblocked: true })` for structure.",
    "- Write safely: read first, then `nodes_write({ op: \"update\", id, if_updated_at, patch })` — a 409 means another session wrote; re-fetch, rebase, retry. Never rewrite a whole body to flip one checkbox: `nodes_write({ op: \"toggle_checklist_item\", node_id, index })`.",
    "- Structure content with H2 (`##`) headings — each becomes an addressable block (`/n/<node_id>#<block_id>`). Cite blocks, not whole nodes.",
    "- Dependencies are edges, not prose: `links_write({ op: \"link\", from_id, to_id, relation: \"blocked_by\" })`. `nodes({ op: \"list\", unblocked: true })` answers \"what can I start now\".",
    "- Node semantics: `kind` says what a node is; reusable workspace tags say what it is about; `parent_id` optionally connects semantic nodes into a real hierarchy. Read `tags` before assigning stable tag ids. `folder` and `category` are not node fields. Tags classify and filter, never grant access or replace workspace RLS.",
    "- Re-sync long sessions with `list_changes({ since })` instead of re-reading the tree.",
    "",
  ].join("\n");
}

function renderAgentsMd(
  skills: readonly Skill[],
  opts?: { workspaceName?: string },
): string {
  const header = [
    `# AGENTS.md`,
    "",
    opts?.workspaceName
      ? `Agent skills curated in the **${opts.workspaceName}** Bcontext workspace.`
      : `Agent skills curated in this Bcontext workspace.`,
    "",
    `_Generated. Do not edit by hand — change the underlying skill node and re-export._`,
    "",
    renderAgentPreamble(),
  ];
  if (skills.length === 0) {
    return [...header, "_No skills defined yet._", ""].join("\n");
  }
  const sections = skills.map((s) =>
    [`## ${s.name}`, "", s.description, "", s.body, ""].join("\n"),
  );
  return [...header, ...sections].join("\n");
}

function renderClaudeMd(
  skills: readonly Skill[],
  opts?: { workspaceName?: string },
): string {
  // CLAUDE.md uses the same conventions as AGENTS.md today; if/when they
  // diverge we split the renderers.
  return renderAgentsMd(skills, opts);
}

function renderCursorRules(skills: readonly Skill[]): string {
  // Cursor `.cursor/rules/*.mdc` are normally one file per rule. This
  // generator emits a single concatenated file, which the GitHub push
  // writes as `.cursor/rules/bcontext.mdc`.
  return skills
    .map((s) =>
      [
        "---",
        `description: ${s.description}`,
        "alwaysApply: false",
        "---",
        "",
        s.body,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

function renderClineRules(skills: readonly Skill[]): string {
  if (skills.length === 0) return "";
  return skills
    .map((s) => `# ${s.name}\n${s.description}\n\n${s.body}`)
    .join("\n\n---\n\n");
}
