/**
 * GET /api/workspaces/:ws/export — the whole workspace as a zip of Markdown
 * files plus an `index.md` manifest; the settings drawer's "Export" button.
 * Read verb via `openWorkspace`, so the archive holds only what the
 * principal may read. The inverse of `import/route.ts`.
 */
import JSZip from "jszip";
import { exportNodeAsMarkdown } from "@/lib/export-md";
import { getNodeTags } from "@bcontext-dev/contract/types";
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";

/** Flat schema-v2 Markdown export: tags classify; filesystem paths do not. */
export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string }> },
) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;

  const nodes = await storage.listNodes();
  const zip = new JSZip();
  const entries: Array<{ title: string; filename: string; tags: string[] }> = [];
  for (const node of nodes) {
    const exported = exportNodeAsMarkdown(node);
    // Reserve index.md for the archive manifest without discarding a node
    // whose historical slug happens to be "index".
    const filename = exported.filename.toLowerCase() === "index.md"
      ? `index-${node.id}.md`
      : exported.filename;
    zip.file(filename, exported.body);
    entries.push({ title: node.title, filename, tags: getNodeTags(node) });
  }

  const index = [
    "---",
    "bcontext_export_schema: 2",
    `workspace: ${JSON.stringify(storage.workspace.name)}`,
    "layout: flat",
    "classification: tags",
    "---",
    "",
    `# Workspace export — ${storage.workspace.name}`,
    "",
    ...entries
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((entry) => {
        const suffix = entry.tags.length > 0 ? ` — ${entry.tags.map((tag) => `#${tag}`).join(" ")}` : "";
        return `- [${entry.title}](${entry.filename})${suffix}`;
      }),
    "",
  ];
  zip.file("index.md", index.join("\n"));

  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${ws}.zip"`,
      "Cache-Control": "no-store",
    },
  });
});
