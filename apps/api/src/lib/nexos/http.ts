/**
 * What every `/api/nexos/*` route repeats: open the workspace at the right
 * level, load the Nexo the path names, map the caller to audit fields, and
 * turn the module's refusals into responses.
 *
 * Access levels (the scope is what a bearer token must carry; a cookie
 * session is bounded by its verbs alone):
 *   read   — verb `read`,  scope `agents:read`   (list, detail, runs, inbox)
 *   chat   — verb `read`,  scope `chat:run`      (chat history)
 *   manage — verb `write`, scope `agents:write`  (create, edit, delete, bindings, prompt)
 *   admin  — verb `admin`, scope `agents:write`  (granting external capabilities:
 *            the same people who may grant them to any other principal)
 */
import { z } from "zod";
import { openWorkspace, type WorkspaceContext } from "@/lib/auth/workspace";
import { actingUserId, type Actor } from "@/lib/auth/require";
import { appendAudit, type ActorType } from "@/lib/audit";
import type { Nexo } from "@bcontext-dev/contract/nexos";
import { getNexo, NexoConflictError, nexoTarget } from "./store";
import { NexoError } from "./lifecycle";
import type { NexoTarget } from "./types";

export type NexoAccess = "read" | "chat" | "manage" | "admin";

export interface NexoContext extends WorkspaceContext {
  target: NexoTarget;
  userId: string | null;
}

/** The workspace slug: `?workspace=` (or a body field the route passes in). */
export function workspaceParam(req: Request, fromBody?: string | null): string | null {
  return new URL(req.url).searchParams.get("workspace")?.trim() || fromBody?.trim() || null;
}

export async function openNexos(
  req: Request,
  workspace: string | null,
  access: NexoAccess,
): Promise<NexoContext | Response> {
  const ctx =
    access === "read"
      ? await openWorkspace(req, workspace, "read", { scope: "agents:read" })
      : access === "chat"
        ? await openWorkspace(req, workspace, "read", { scope: "chat:run" })
        : access === "manage"
          ? await openWorkspace(req, workspace, "write", { scope: "agents:write" })
          : await openWorkspace(req, workspace, "admin", { scope: "agents:write" });
  if (ctx instanceof Response) return ctx;
  return { ...ctx, target: nexoTarget(ctx.storage), userId: actingUserId(ctx.actor) };
}

/** The Nexo named in the path, inside this workspace, or a 404 response. */
export async function loadNexo(ctx: NexoContext, id: string): Promise<Nexo | Response> {
  const nexo = await getNexo(ctx.target, id);
  return nexo ?? Response.json({ error: "nexo_not_found" }, { status: 404 });
}

/** Append an audit row for a write. Demo workspaces have no audit chain. */
export function auditNexo(
  ctx: NexoContext,
  action: string,
  target: { type: string; id: string },
  input?: unknown,
): void {
  if (ctx.storage.backend !== "supabase") return;
  const actor: Actor = ctx.actor;
  const actorType: ActorType =
    actor.kind === "agent" || actor.kind === "agent_user" ? "agent" : actor.kind === "user" ? "user" : "demo";
  void appendAudit({
    workspaceId: ctx.storage.workspace.id,
    actorType,
    actorId: actor.kind === "user" || actor.kind === "agent_user" ? actor.userId : null,
    agentTokenId: actor.kind === "agent" || actor.kind === "agent_user" ? actor.tokenId : null,
    action,
    targetType: target.type,
    targetId: target.id,
    input,
  });
}

/** JSON body through a zod schema, or a 400. */
export async function parseBody<T>(
  req: Request,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid_request", message: "body must be JSON" }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", message: parsed.error.issues[0]?.message ?? "invalid body", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  return parsed.data;
}

/** Module refusals → responses; anything else rethrows to `withRoute`. */
export function nexoErrorResponse(err: unknown): Response {
  if (err instanceof NexoError) {
    return Response.json({ error: err.code, message: err.message }, { status: err.status });
  }
  if (err instanceof NexoConflictError) {
    return Response.json({ error: err.code, message: err.message }, { status: 409 });
  }
  throw err;
}
