/**
 * POST /api/connectors/[id]/uninstall
 *
 * Revokes the install. Flips status to 'uninstalled' and calls the
 * connector's authorize(phase='revoke') to invalidate tokens on the
 * external side (for a Nango-backed install with its own OAuth app, the
 * per-workspace integration in Nango goes too). Connector-sourced nodes
 * are NOT deleted — the user keeps their imported content.
 */
import { z } from "zod";
import { gate } from "@/lib/auth/require";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { getConnectorOrNull } from "@/lib/connectors/registry";
import { getInstall, updateInstall } from "@/lib/connectors/installs";
import { revokeInstallPrincipal } from "@/lib/auth/install-principal";
import "@/lib/connectors/bootstrap";

const Schema = z.object({ workspace_id: z.string().uuid() });

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export const POST = withRoute(async (req: Request, ctx: RouteCtx) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (gated.kind !== "user") {
    return Response.json(
      { error: "user_session_required" },
      { status: 403 },
    );
  }
  const { id: connectorId } = await ctx.params;
  const connector = getConnectorOrNull(connectorId);
  if (!connector) {
    return Response.json({ error: "unknown_connector" }, { status: 404 });
  }
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Schema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const install = await getInstall(parsed.data.workspace_id, connector.id);
  if (!install) {
    return Response.json({ error: "not_installed" }, { status: 404 });
  }

  try {
    await connector.authorize(
      {
        workspaceId: install.workspace_id,
        installId: install.id,
        config: install.config,
        secret: null,
      },
      "revoke",
    );
  } catch {
    // best-effort — never block the local uninstall on a remote failure
  }
  await updateInstall(install.id, { status: "uninstalled", secret_ref: null });
  // The bot's grant goes with the install: a slash command from a team whose
  // install is gone finds no install, but a stale live grant would still be
  // one `active` flip away from searching again.
  if (connector.id === "slack") {
    await revokeInstallPrincipal(install.workspace_id, install.id);
  }
  return Response.json({ ok: true });
});
