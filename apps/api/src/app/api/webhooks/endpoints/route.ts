/**
 * Outbound webhook endpoints — CRUD list/create.
 *
 *   GET  /api/webhooks/endpoints?workspace_id=<uuid>
 *   POST /api/webhooks/endpoints
 *
 * Both require an authenticated user session; RLS enforces that the
 * caller is owner|admin in the target workspace.
 */
import { z } from "zod";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { withRoute } from "@/lib/route";
import {
  generateSecret,
  hashSecret,
  parseEventTypes,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "@bcontext-dev/contract/webhooks/events";

const EventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

const CreateBodySchema = z.object({
  workspace_id: z.string().uuid(),
  url: z.string().url().max(1000),
  event_types: z.array(EventTypeSchema).min(1),
});

interface EndpointRow {
  id: string;
  workspace_id: string;
  url: string;
  event_types: string[];
  secret_prefix: string;
  paused: boolean;
  created_at: string;
  last_delivery_at: string | null;
}

interface PublicEndpoint {
  id: string;
  workspace_id: string;
  url: string;
  event_types: WebhookEventType[];
  secret_prefix: string;
  paused: boolean;
  created_at: string;
  last_delivery_at: string | null;
}

function project(row: EndpointRow): PublicEndpoint {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    url: row.url,
    event_types: parseEventTypes(row.event_types),
    secret_prefix: row.secret_prefix,
    paused: row.paused,
    created_at: row.created_at,
    last_delivery_at: row.last_delivery_at,
  };
}

export const GET = withRoute(async (req: Request) => {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace_id");
  if (!workspaceId || !z.string().uuid().safeParse(workspaceId).success) {
    return Response.json(
      { error: "invalid_request", message: "workspace_id (uuid) is required" },
      { status: 400 },
    );
  }

  const supabase = getSupabaseForRequest(req);
  const { data: session } = await supabase.auth.getUser();
  if (!session.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("webhook_endpoints")
    .select(
      "id, workspace_id, url, event_types, secret_prefix, paused, created_at, last_delivery_at",
    )
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) {
    return Response.json(
      { error: "internal", message: error.message },
      { status: 500 },
    );
  }
  return Response.json({
    endpoints: (data ?? []).map((row) => project(row as EndpointRow)),
  });
});

export const POST = withRoute(async (req: Request) => {
  let parsed: z.infer<typeof CreateBodySchema>;
  try {
    const json = await req.json();
    const result = CreateBodySchema.safeParse(json);
    if (!result.success) {
      return Response.json(
        { error: "invalid_request", issues: result.error.flatten() },
        { status: 400 },
      );
    }
    parsed = result.data;
  } catch {
    return Response.json(
      { error: "invalid_request", message: "body must be JSON" },
      { status: 400 },
    );
  }

  const supabase = getSupabaseForRequest(req);
  const { data: session } = await supabase.auth.getUser();
  if (!session.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { secret, prefix } = generateSecret();
  const secret_hash = await hashSecret(secret);

  const { data, error } = await supabase
    .from("webhook_endpoints")
    .insert({
      workspace_id: parsed.workspace_id,
      url: parsed.url,
      event_types: parsed.event_types,
      secret_prefix: prefix,
      secret_hash,
      created_by: session.user.id,
    })
    .select(
      "id, workspace_id, url, event_types, secret_prefix, paused, created_at, last_delivery_at",
    )
    .single();
  if (error || !data) {
    const message = error?.message ?? "no row";
    if (/row-level security|permission denied|new row violates/i.test(message)) {
      return Response.json(
        { error: "forbidden", message: "owner or admin role required" },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "internal", message },
      { status: 500 },
    );
  }

  return Response.json(
    { endpoint: project(data as EndpointRow), secret },
    { status: 201 },
  );
});
