/**
 * GET /api/connectors?workspace=<slug>
 *
 * Lists connector_installs visible to the current user for a workspace.
 * Returns a sanitised view (no secret_ref). The Slack install carries
 * `access` — what the bot can search and how to narrow it — so the screen
 * that shows the connector can say it rather than leave it implied.
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { listInstalls } from "@/lib/connectors/installs";
import { describeInstallAccess, resolveInstallGrant } from "@/lib/auth/install-principal";

export const GET = withRoute(async (req: Request) => {
  const ws = new URL(req.url).searchParams.get("workspace");
  // `scope: null` keeps this route's token requirement exactly where it was —
  // it called `gate(req)` with no scope. This change adds the verb axis; it is
  // not the place to start demanding scopes that issued tokens do not carry.
  const ctx = await openWorkspace(req, ws, "read", { scope: null });
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;
  if (storage.backend !== "supabase") {
    return Response.json({ installs: [] });
  }
  const rows = await listInstalls(storage.workspace.id);
  // Strip secret_ref before returning to clients.
  const safe = await Promise.all(
    rows.map(async ({ secret_ref: _unused, ...rest }) =>
      rest.connector_id === "slack" && rest.status !== "uninstalled"
        ? { ...rest, access: describeInstallAccess(await resolveInstallGrant(rest.workspace_id, rest.id)) }
        : rest,
    ),
  );
  return Response.json({ installs: safe });
});
