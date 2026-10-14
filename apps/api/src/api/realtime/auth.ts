/**
 * Who is on the other end of a socket, and what they may listen to.
 *
 * The handshake carries `?token=`, and the token is one of the two things the
 * API already trusts: a `bctx_live_…` API token (agents) or the access JWT of a
 * Supabase session (people — the browser has it, and a WebSocket upgrade to
 * another host does not carry the session cookie). Nothing new is minted and
 * nothing new is validated; a WebSocket is just a request that stays open.
 *
 * Authorisation is the grant, not workspace membership: `resolveGrant`
 * answers "may this principal read this workspace", and for a document room
 * the node also has to be within the principal's reach — the same
 * `scopedStorage` that hides it from list_nodes hides its cursors too.
 */
import { createClient } from "@supabase/supabase-js";
import { requireAuth, type Actor } from "@/lib/auth/require";
import { isDenied, resolveGrant, type Grant } from "@/lib/auth/grants";
import { getStorageById } from "@/lib/storage";
import { scopedStorage } from "@/lib/storage/scoped";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { supabaseAnonKey, supabaseUrl } from "@/lib/env";

const API_TOKEN_PREFIX = "bctx_live_";

export async function authenticate(token: string | null): Promise<Actor | null> {
  if (!token) return null;
  if (token.startsWith(API_TOKEN_PREFIX)) {
    try {
      return await requireAuth(new Request("http://realtime/", { headers: { authorization: `Bearer ${token}` } }));
    } catch {
      return null;
    }
  }
  const url = supabaseUrl();
  const anon = supabaseAnonKey();
  if (!url || !anon) return null;
  const { data, error } = await createClient(url, anon, { auth: { persistSession: false } }).auth.getUser(token);
  if (error || !data.user) return null;
  return { kind: "user", userId: data.user.id };
}

/** May the actor listen to a workspace room? Returns the grant, or null. */
export async function authoriseWorkspace(actor: Actor, workspaceId: string): Promise<Grant | null> {
  const grant = await resolveGrant(actor, workspaceId);
  if (isDenied(grant) || !grant.verbs.includes("read")) return null;
  return grant;
}

export interface NodeRoomAccess {
  grant: Grant;
  workspaceId: string;
  /** Doc updates from this peer are relayed only if it may write. */
  canWrite: boolean;
}

/** May the actor join a document room? The node must exist, in a readable workspace, within reach. */
export async function authoriseNode(actor: Actor, nodeId: string): Promise<NodeRoomAccess | null> {
  const { data: row } = await getSupabaseAdmin()
    .from("nodes")
    .select("workspace_id")
    .eq("id", nodeId)
    .maybeSingle();
  const workspaceId = (row as { workspace_id?: string } | null)?.workspace_id;
  if (!workspaceId) return null;

  const grant = await authoriseWorkspace(actor, workspaceId);
  if (!grant) return null;

  const inner = await getStorageById(workspaceId);
  if (!inner) return null;
  // Out of reach reads as missing, here as everywhere else.
  const visible = await scopedStorage(inner, grant).getNode(nodeId);
  if (!visible) return null;

  return { grant, workspaceId, canWrite: grant.verbs.includes("write") };
}
