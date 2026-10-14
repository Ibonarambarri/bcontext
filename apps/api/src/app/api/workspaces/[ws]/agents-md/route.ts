/**
 * GET /api/workspaces/[ws]/agents-md?format=agents-md|claude-md|cursor-rules|cline-rules
 *
 * Returns a generated agent-rules file derived from the workspace's skill
 * nodes (any node whose content_md starts with SKILL.md frontmatter).
 *
 * Defaults to AGENTS.md. Always serves text/markdown.
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { extractSkills, generate, type Format } from "@/lib/skills/generate";
import { withRoute } from "@/lib/route";

const FORMATS: Format[] = [
  "agents-md",
  "claude-md",
  "cursor-rules",
  "cline-rules",
];

function pickFormat(raw: string | null): Format {
  if (!raw) return "agents-md";
  return (FORMATS as string[]).includes(raw) ? (raw as Format) : "agents-md";
}

function filenameFor(format: Format): string {
  switch (format) {
    case "agents-md":
      return "AGENTS.md";
    case "claude-md":
      return "CLAUDE.md";
    case "cursor-rules":
      return "cursor-rules.mdc";
    case "cline-rules":
      return ".clinerules";
  }
}

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;

  const format = pickFormat(new URL(req.url).searchParams.get("format"));
  const download = new URL(req.url).searchParams.get("download") === "1";

  const nodes = await storage.listNodes();
  const skills = extractSkills(nodes);
  const body = generate(format, skills, {
    workspaceName: storage.workspace.name,
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      ...(download
        ? {
            "Content-Disposition": `attachment; filename="${filenameFor(format)}"`,
          }
        : {}),
    },
  });
});
