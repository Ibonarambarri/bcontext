/**
 * GET /api/nexos/channels?workspace=&install_id= — the Slack channels of one
 * connector install (first-party `slack` or `slack-nango`), for the channel
 * picker when a source is given to a Nexo. Answers
 * `{ channels: [{ id, name, is_private, is_member }], truncated }`.
 *
 * Read access (`agents:read`): it only names channels the install can see.
 * 400 `unsupported` for any other connector (the web then offers typed
 * channel ids), 404 `install_not_found` outside this workspace, 502
 * `slack_error` when Slack or Nango refuses.
 */
import { withRoute } from "@/lib/route";
import type { NexoChannelsResponse } from "@bcontext-dev/contract/nexos";
import { openNexos, workspaceParam } from "@/lib/nexos/http";
import { listSlackChannels } from "@/lib/nexos/slack-channels";

export const GET = withRoute(async (req: Request) => {
  const installId = new URL(req.url).searchParams.get("install_id")?.trim();
  if (!installId) {
    return Response.json({ error: "invalid_request", message: "install_id is required" }, { status: 400 });
  }
  const ctx = await openNexos(req, workspaceParam(req), "read");
  if (ctx instanceof Response) return ctx;

  const out = await listSlackChannels(ctx.target, installId);
  if (out.ok) return Response.json({ channels: out.channels, truncated: out.truncated } satisfies NexoChannelsResponse);
  if (out.error === "install_not_found") return Response.json({ error: out.error }, { status: 404 });
  if (out.error === "unsupported") {
    return Response.json({ error: "unsupported", message: "Only Slack installs list channels." }, { status: 400 });
  }
  return Response.json({ error: "slack_error", message: out.error }, { status: 502 });
});
