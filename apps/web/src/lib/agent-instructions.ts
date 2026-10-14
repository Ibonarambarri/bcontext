/**
 * The rules file a project hands its coding agent so that it works a
 * Bcontext workspace well — the "what to put in CLAUDE.md" answer.
 *
 * Connecting the MCP server gives an agent the tools; it does not give it
 * the habits (start with `brief`, one task with subtasks, `## Result` when
 * done, edges instead of prose). Those live in the file every runtime reads
 * at session start — CLAUDE.md for Claude Code, AGENTS.md for Codex and
 * Zed, `.cursor/rules` for Cursor… — so the "Add agent" box and the
 * quickstart render one here, with the workspace's own address baked in.
 *
 * Pure, no React: `agent-instructions.test.ts` pins the shape. The
 * conventions mirror the plugin's skill (`Bcontext-dev/bcontext-plugin`)
 * and the server's `instructions`; when those change, this changes too.
 */
import type { McpTarget } from "@/lib/mcp-endpoint";

/** Where a runtime reads project-level instructions from, and how. */
export interface RulesFile {
  /** Path relative to the project root. */
  path: string;
  /** The frontmatter the runtime expects, if any (Cursor's `.mdc`). */
  frontmatter?: string;
}

/**
 * The file each runtime reads at session start. Anything not listed reads
 * AGENTS.md, the cross-vendor default; Claude Desktop / claude.ai have no
 * project file, so the same text goes in the project's instructions.
 */
export function rulesFileFor(providerSlug: string): RulesFile {
  switch (providerSlug) {
    case "claude-code":
      return { path: "CLAUDE.md" };
    case "cursor":
      return {
        path: ".cursor/rules/bcontext.mdc",
        frontmatter: ["---", "description: How this project uses Bcontext", "alwaysApply: true", "---", ""].join("\n"),
      };
    case "windsurf":
      return { path: ".windsurf/rules/bcontext.md" };
    case "cline":
      return { path: ".clinerules" };
    case "gemini-cli":
      return { path: "GEMINI.md" };
    case "github-copilot":
    case "vscode":
      return { path: ".github/copilot-instructions.md" };
    case "goose":
      return { path: ".goosehints" };
    default:
      return { path: "AGENTS.md" };
  }
}

/**
 * The instructions themselves, with this workspace's address and server
 * name in place. Markdown, ready to paste at the top of the rules file.
 */
export function agentInstructions(
  target: McpTarget,
  address: { org: string; slug: string },
  providerSlug = "claude-code",
): string {
  const { frontmatter = "" } = rulesFileFor(providerSlug);
  const workspace = `${address.org}/${address.slug}`;
  return (
    frontmatter +
    `# Bcontext — how this project keeps its memory

The shared memory of this project is the Bcontext workspace **${workspace}**,
reached over MCP as \`${target.serverName}\`:
${target.endpoint}

Tasks, decisions, research and docs live there, not in loose markdown files.
Nothing you do not write down exists for the next session or for anyone else
on the team.

## Every session

1. Start with \`brief\` — one call: the unblocked queue by priority, open
   decisions, what is assigned to you and what changed since your last brief.
2. Before researching anything, \`ask_nexo({ question })\`: what the team
   already knows, cited. Follow a \`/n/<id>#<block>\` ref with
   \`nodes({ op: "get" })\` before acting on it.
3. Work inside one task: pick it from the queue or create it, set
   \`status: "in_progress"\`, and put its steps in \`subtasks\` — never split
   one piece of work into several task nodes.
4. Close it: \`status: "done"\` and \`nodes_write({ op: "append", heading:
   "Result" })\` with what changed, what was decided and what is left. A
   judgment call you made along the way is a \`decision\` node
   (Question / Decision / Consequences / Status) linked to the task.

## Writing

- Titles are plain names, no codes or prefixes. Bodies use \`##\` headings:
  each one is a block others can cite (\`/n/<id>#<slug>\`).
- Dependencies are edges, never prose: \`links_write\` with \`blocked_by\`,
  \`references\` or \`contributes_to\` (a goal). \`unblocked: true\` in
  \`nodes({ op: "list" })\` is only right when the edges are.
- Read before you rewrite: pass \`if_updated_at\`, prefer \`append\`,
  \`replace_block\` and \`toggle_checklist_item\` over rewriting a body. A 409
  means someone else wrote first — re-fetch, merge, retry.
- \`tags\` before \`tag_ids\`; create the tag if it is missing. Archive tasks
  that are finished or dropped so live views stay about live work.
- Credentials are read redacted and used through \`materialize\`; never copy
  a secret into a node, a commit or a message.

## Re-sync

In a long session, \`list_changes({ since })\` instead of re-reading the
workspace. External tools and the workspace's skills are found with
\`capability_search\` and called with \`capability_call\`.
`
  );
}
