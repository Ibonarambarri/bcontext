/**
 * The workspace's weekly digest — NEXO's first scheduled skill.
 *
 *   GET  /api/workspaces/:ws/digest   → current settings (disabled by default)
 *   PUT  /api/workspaces/:ws/digest   → enable/disable, cron, timezone, delivery
 *   POST /api/workspaces/:ws/digest   → publish one now (the sales demo)
 *
 * Admin verb: a digest is workspace-wide and may email the admins. Settings
 * live in `skill_schedules` (Supabase only — the demo store has no clock, so
 * PUT answers 400 there); POST works everywhere, including the demo store,
 * because publishing reads the feed and writes a node through the Storage.
 */
import { z } from "zod";
import { openWorkspace } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { publishWeeklyDigest } from "@/lib/skills/digest";
import {
  DEFAULT_DIGEST_SETTINGS,
  DigestSettingsError,
  getDigestSettings,
  upsertDigestSettings,
} from "@/lib/skills/schedules";

const Put = z.object({
  enabled: z.boolean().optional(),
  cron: z.string().trim().min(9).max(120).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  delivery: z
    .object({ webhook: z.boolean().optional(), email: z.boolean().optional() })
    .strict()
    .optional(),
}).strict();

const Post = z.object({
  /** Window in days; 7 by default. */
  days: z.number().int().min(1).max(31).optional(),
  delivery: z
    .object({ webhook: z.boolean().optional(), email: z.boolean().optional() })
    .strict()
    .optional(),
}).strict();

type Params = { params: Promise<{ ws: string }> };

export const GET = withRoute(async (req: Request, { params }: Params) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "admin");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;
  if (storage.backend !== "supabase") {
    return Response.json({ digest: DEFAULT_DIGEST_SETTINGS, backend: "demo" });
  }
  const digest = await getDigestSettings(getSupabaseAdmin(), storage.workspace.id);
  return Response.json({ digest });
});

export const PUT = withRoute(async (req: Request, { params }: Params) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "admin");
  if (ctx instanceof Response) return ctx;
  const { storage, actor } = ctx;

  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Put.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_body", message: parsed.error.issues[0]?.message ?? "invalid body", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (storage.backend !== "supabase") {
    return Response.json(
      { error: "unsupported", message: "Scheduling the digest needs Supabase; POST publishes one now." },
      { status: 400 },
    );
  }
  try {
    const digest = await upsertDigestSettings(getSupabaseAdmin(), storage.workspace.id, parsed.data, {
      createdBy: actor.kind === "user" || actor.kind === "agent_user" ? actor.userId : null,
    });
    return Response.json({ digest });
  } catch (err) {
    if (err instanceof DigestSettingsError) {
      return Response.json({ error: "invalid_body", field: err.field, message: err.message }, { status: 400 });
    }
    throw err;
  }
});

export const POST = withRoute(async (req: Request, { params }: Params) => {
  const { ws } = await params;
  const ctx = await openWorkspace(req, ws, "admin");
  if (ctx instanceof Response) return ctx;
  const { storage, actor } = ctx;

  let input: z.infer<typeof Post> = {};
  if (req.headers.get("content-length") !== "0" && req.headers.get("content-type")?.includes("json")) {
    const body = await readJsonBody(req);
    if (!body.ok) return body.response;
    const parsed = Post.safeParse(body.data ?? {});
    if (!parsed.success) {
      return Response.json(
        { error: "invalid_body", message: parsed.error.issues[0]?.message ?? "invalid body", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }
    input = parsed.data;
  }

  const result = await publishWeeklyDigest(storage, {
    days: input.days,
    delivery: input.delivery,
    actorKind: actor.kind === "user" ? "human" : actor.kind === "demo" ? "system" : "agent",
    actorId: actor.kind === "user" || actor.kind === "agent_user" ? actor.userId : null,
  });
  return Response.json(
    {
      node: result.node,
      created: result.created,
      model_used: result.model_used,
      delivered: result.delivered,
      facts: {
        from: result.facts.from,
        to: result.facts.to,
        changes: result.facts.changes.total,
        decided: result.facts.decided.length,
        blocked: result.facts.blocked.length,
        startable: result.facts.startable.length,
      },
    },
    { status: result.created ? 201 : 200 },
  );
});
