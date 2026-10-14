/**
 * Who is asking, in the terms saved views care about: user or agent, admin or
 * not, allowed to write or not. Built once per request by `resolveViewRequest`
 * and threaded through the store, which never looks at the raw actor.
 *
 * The result decides view visibility and ownership only. Which *nodes* a view
 * may return is the storage's reach, applied upstream by `openWorkspace`.
 */
import type { Actor } from "@/lib/auth/require";
import { hasScope } from "@bcontext-dev/contract/auth/scopes";
import type { Storage } from "@/lib/storage";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { ViewPrincipal } from "@bcontext-dev/contract/views/types";

/**
 * Agents carry their permissions in scopes; people carry theirs in the
 * workspace membership role, which is one extra read. An agent acting for a
 * person (`agent_user`) needs both: the token cannot exceed the person.
 */
export async function viewPrincipal(actor: Actor, storage: Storage): Promise<ViewPrincipal> {
  if (actor.kind === "demo") return { type: "demo", id: "demo", isAdmin: true, canWrite: true };
  if (actor.kind === "agent") return {
    type: "agent", id: actor.tokenId, isAdmin: hasScope(actor.scopes, "admin:*"), canWrite: hasScope(actor.scopes, "nodes:write"),
  };
  if (actor.kind === "agent_user") {
    const role = await membershipRole(storage.workspace.id, actor.userId);
    return { type: "user", id: actor.userId, isAdmin: hasScope(actor.scopes, "admin:*") || role === "owner" || role === "admin", canWrite: hasScope(actor.scopes, "nodes:write") && role !== "viewer" };
  }
  const role = await membershipRole(storage.workspace.id, actor.userId);
  return { type: "user", id: actor.userId, isAdmin: role === "owner" || role === "admin", canWrite: role !== null && role !== "viewer" };
}

async function membershipRole(workspaceId: string, userId: string): Promise<string | null> {
  const { data } = await getSupabaseAdmin().from("memberships").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  return (data?.role as string | undefined) ?? null;
}
