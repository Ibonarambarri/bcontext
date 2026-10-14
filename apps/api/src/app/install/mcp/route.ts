/**
 * GET /install/mcp — serves `scripts/install-mcp.mjs` as plain text so users
 * can curl-pipe it into Node:
 *
 *   curl -sSL https://<your-instance>/install/mcp | node - --token bctx_live_…
 *
 * The script is checked into the repo, so we read it from disk at request
 * time and stamp this instance's MCP endpoint into it (configured `APP_URL`,
 * else the request's origin — same rule as the discovery documents), so the
 * one-liner installs against whichever server served it. Cached for 5
 * minutes at the edge.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { withRoute } from "@/lib/route";
import { baseUrlFor, mcpResourceUrl } from "@/lib/mcp/resource";

const SCRIPT_RELATIVE_PATH = path.join("scripts", "install-mcp.mjs");
/** The placeholder `install-mcp.mjs` carries for the endpoint; must match the script. */
const SERVED_URL_PLACEHOLDER = '"__BCONTEXT_MCP_URL__"';

export const GET = withRoute(async (req: Request): Promise<Response> => {
  const file = path.join(process.cwd(), SCRIPT_RELATIVE_PATH);
  try {
    const script = await fs.readFile(file, "utf8");
    const body = script.replace(SERVED_URL_PLACEHOLDER, JSON.stringify(mcpResourceUrl(baseUrlFor(req))));
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'inline; filename="install-mcp.mjs"',
        "Cache-Control": "public, max-age=300",
        Vary: "Host",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: "install_script_unavailable", message },
      { status: 500 },
    );
  }
});
