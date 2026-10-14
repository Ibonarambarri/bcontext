/**
 * GET /api/nodes/:id/export?workspace=… — download one node as a Markdown
 * file. The node page's export action; read verb via `openWorkspace`, so a
 * node outside the principal's reach is a 404.
 */
import { exportNodeAsMarkdown } from "@/lib/export-md";
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";

/**
 * GET /api/nodes/[id]/export?workspace=<slug>
 *
 * Returns the node rendered as a Markdown file (YAML frontmatter + body)
 * with a `Content-Disposition: attachment` header so browsers trigger a
 * download instead of rendering inline.
 */
export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const ws = new URL(req.url).searchParams.get("workspace");
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;
  const { id } = await params;
  const node = await storage.getNode(id);
  if (!node) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const { filename, body } = exportNodeAsMarkdown(node);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
});
