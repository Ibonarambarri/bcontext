/**
 * Conversation persistence for the hub chat.
 *
 * Backed by the `chat_sessions` (= a conversation) and `chat_messages` (= its
 * turns) tables, which have existed since `0001_init` but were never wired up.
 * Each conversation belongs to one workspace (= one business) and one user.
 *
 * Service-role access, gated in app code — same contract as the rest of the
 * storage layer: callers (API routes) prove workspace membership via `gate()`
 * before invoking these, so the service-role client may bypass RLS safely.
 * Every read/write is scoped explicitly so a wrong-workspace/user row never
 * escapes.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { findWorkspaceByRef } from "@/lib/workspaces/resolve";

export interface Conversation {
  id: string;
  workspace_id: string;
  user_id: string | null;
  title: string | null;
  /** The specialist Nexo this conversation is with; null = the general Nexo. */
  nexo_id: string | null;
  created_at: string;
  updated_at: string;
}

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface StoredMessage {
  id: string;
  session_id: string;
  role: ChatRole;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    workspace_id: row.workspace_id as string,
    user_id: (row.user_id as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    nexo_id: (row.nexo_id as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string | null) ?? (row.created_at as string),
  };
}

function rowToMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    role: row.role as ChatRole,
    content: (row.content as string) ?? "",
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: row.created_at as string,
  };
}

/** Conversations for a user in a workspace, most-recently-active first. */
export async function listConversations(
  workspaceId: string,
  userId: string,
): Promise<Conversation[]> {
  const admin = getSupabaseAdmin();
  // The general Nexo's history only: a specialist's conversations carry its
  // `nexo_id` and are listed on its own page (`/api/nexos/:id/sessions`).
  const { data, error } = await admin
    .from("chat_sessions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .is("nexo_id", null)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`listConversations: ${error.message}`);
  return (data ?? []).map(rowToConversation);
}

/**
 * Resolve a conversation by id, scoped to its owner. `user_id` ownership IS
 * the authorization boundary for per-conversation reads/writes — a caller can
 * only touch conversations they created.
 */
export async function getConversationById(
  conversationId: string,
  userId: string,
): Promise<Conversation | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("chat_sessions")
    .select("*")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`getConversationById: ${error.message}`);
  return data ? rowToConversation(data) : null;
}

/**
 * Resolve a workspace id from its slug, but only if `userId` is a member.
 * Returns null when the workspace doesn't exist or the user isn't a member —
 * the caller maps that to 404/403. Used to authorize list/create.
 */
export async function resolveMemberWorkspaceId(
  slug: string,
  userId: string,
): Promise<string | null> {
  const admin = getSupabaseAdmin();
  const ws = await findWorkspaceByRef(slug, "id");
  if (!ws) return null;
  const { data: mem } = await admin
    .from("memberships")
    .select("user_id")
    .eq("workspace_id", ws.id as string)
    .eq("user_id", userId)
    .maybeSingle();
  if (!mem) return null;
  return ws.id as string;
}

export async function createConversation(
  workspaceId: string,
  userId: string,
  title?: string | null,
  nexoId: string | null = null,
): Promise<Conversation> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("chat_sessions")
    .insert({
      workspace_id: workspaceId,
      user_id: userId,
      title: normalizeTitle(title) ?? null,
      // Null for the general Nexo, so its history stays where it always was.
      ...(nexoId ? { nexo_id: nexoId } : {}),
    })
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`createConversation: ${error?.message ?? "no row"}`);
  }
  return rowToConversation(data);
}

/** Ordered turns of a conversation (oldest first). */
export async function getMessages(
  conversationId: string,
): Promise<StoredMessage[]> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("chat_messages")
    .select("*")
    .eq("session_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(1000);
  if (error) throw new Error(`getMessages: ${error.message}`);
  return (data ?? []).map(rowToMessage);
}

export async function appendMessage(
  conversationId: string,
  msg: { role: ChatRole; content: string; metadata?: Record<string, unknown> },
): Promise<StoredMessage> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("chat_messages")
    .insert({
      session_id: conversationId,
      role: msg.role,
      content: msg.content,
      metadata: msg.metadata ?? {},
    })
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`appendMessage: ${error?.message ?? "no row"}`);
  }
  return rowToMessage(data);
}

export async function renameConversation(
  conversationId: string,
  userId: string,
  title: string,
): Promise<Conversation | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("chat_sessions")
    .update({ title: normalizeTitle(title) ?? "Untitled" })
    .eq("id", conversationId)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`renameConversation: ${error.message}`);
  return data ? rowToConversation(data) : null;
}

export async function deleteConversation(
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from("chat_sessions")
    .delete()
    .eq("id", conversationId)
    .eq("user_id", userId);
  if (error) throw new Error(`deleteConversation: ${error.message}`);
  return true;
}

/**
 * Derive a short conversation title from the first user message. Collapses
 * whitespace, takes the first ~6 words, trims trailing punctuation, caps at
 * 60 chars. Returns null for empty input so the caller can leave it null.
 */
export function titleFromFirstMessage(text: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const words = clean.split(" ").slice(0, 6).join(" ");
  const capped = words.length > 60 ? words.slice(0, 57) + "…" : words;
  return capped.replace(/[.,;:!?]+$/, "");
}

function normalizeTitle(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const t = title.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > 80 ? t.slice(0, 80) : t;
}
