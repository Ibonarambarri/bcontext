/**
 * DELETE /api/organizations/[org]/agents/[id] — cut an agent off, from the
 * organization's tab rather than from one workspace's.
 *
 * `/api/agents/connections/[id]` already disconnects an agent, but a workspace
 * at a time and only for somebody who administers that workspace. An
 * organization owner looking at "what can read our data" has the opposite
 * shape of question: they are answerable for the company, they can see an
 * agent reaching four projects, and disconnecting it four times — once per
 * project, with the last call being the one that actually revokes the tokens —
 * is a way to leave an agent half-connected by getting distracted.
 *
 * ## The uuid is not the authorization
 *
 * `gateOrgAdmin` says the caller administers *this* company; it says nothing
 * about the agent named in the path, and `agents` is a global table. So the
 * reach check below is not a nicety: without it an administrator of one
 * company could revoke another company's agent by guessing a uuid, and the
 * blast radius of that guess is total, because revocation here is global.
 * A miss answers 404 and not 403 — "does not exist" is the answer this
 * codebase gives to "may I?", for the reason spelled out in
 * `@/lib/organizations/admin`.
 *
 * ## Everywhere, deliberately
 *
 * `revokeAgentEverywhere` is global: it revokes the identity, every access
 * row, every token and every grant, including ones in workspaces of *other*
 * organizations the agent may also reach. That is the honest reading of the
 * act — the button says the agent should not be able to read this company's
 * context again, and an agent left alive elsewhere keeps its identity and its
 * tokens, which is precisely the state an administrator thought they had
 * ended. Cross-organization sharing of one agent identity is not something
 * the product offers, so in practice "everywhere" and "here" are the same set.
 */
import { z } from "zod";
import { revokeAgentEverywhere } from "@/lib/agents/connections.server";
import { appendAudit } from "@/lib/audit";
import { gateOrgAdmin } from "@/lib/organizations/admin";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const DELETE = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ org: string; id: string }> },
) => {
  const { org, id } = await params;
  // Not `platformAdmin: "read"`: this writes. The instance-admin allowlist opens
  // the reading routes so `/admin` can tell whether a customer is alive, and
  // stops there — revoking a customer's agent is theirs to do.
  const gated = await gateOrgAdmin(req, org);
  if (gated instanceof Response) return gated;
  if (!z.string().uuid().safeParse(id).success) {
    return Response.json({ error: "invalid_id" }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { data: wsRows } = await admin
    .from("workspaces")
    .select("id")
    .eq("organization_id", gated.org.id);
  const workspaceIds = ((wsRows ?? []) as Array<{ id: string }>).map((w) => w.id);
  if (workspaceIds.length === 0) return notFound();

  // Live access only. An agent whose rows are all revoked already reaches
  // nothing here, and revoking it again would be this route reporting success
  // for a company that no longer has anything to do with it.
  const { data: access } = await admin
    .from("agent_workspace_access")
    .select("workspace_id")
    .eq("agent_id", id)
    .in("workspace_id", workspaceIds)
    .is("revoked_at", null);
  const reached = ((access ?? []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id);
  if (reached.length === 0) return notFound();

  await revokeAgentEverywhere(admin, id);

  // One entry per workspace the agent was reaching: the audit chain is
  // per-workspace, so a single entry would leave the other projects with no
  // record that anything about their access changed today.
  for (const workspaceId of reached) {
    void appendAudit({
      workspaceId,
      actorType: "user",
      actorId: gated.actor.userId,
      action: "agent.connection.revoke",
      targetType: "agent",
      targetId: id,
      input: { via: "organization", organization_id: gated.org.id },
    });
  }

  return Response.json({ ok: true });
});

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}
