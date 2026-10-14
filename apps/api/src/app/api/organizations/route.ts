/**
 * POST /api/organizations — a signed-in person creates an organization,
 * becomes its owner and gets its first workspace.
 *
 *   body  { name, slug?, workspace_name? }          (CreateOrganizationBody)
 *   201   { organization, workspace }               (CreateOrganizationResult)
 *   400   invalid_body | invalid_name
 *   401   not a session (a bearer token is an agent, and agents do not found companies)
 *   403   org_creation_restricted — `ORG_CREATION=admin` and the caller is not an instance admin
 *   409   slug_taken
 *   503   not_configured — demo backend, no organizations to create
 *
 * The rules live in `@/lib/organizations/create`; this file parses and maps.
 */
import { z } from "zod";
import { gate } from "@/lib/auth/require";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { supabaseConfigured } from "@/lib/env";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { createOrganizationForUser, OrgCreateError } from "@/lib/organizations/create";
import { ORG_NAME_MAX } from "@bcontext-dev/contract/organizations";

const Body = z.object({
  name: z.string().trim().min(1, "The organization needs a name.").max(ORG_NAME_MAX),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, numbers and dashes.")
    .max(60)
    .optional(),
  workspace_name: z.string().trim().min(1).max(80).optional(),
});

export const POST = withRoute(async (req: Request) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (gated.kind !== "user") {
    return Response.json(
      { error: "user_session_required", message: "Sign in to create an organization." },
      { status: 401 },
    );
  }
  if (!supabaseConfigured()) {
    return Response.json(
      { error: "not_configured", message: "Organizations need the Supabase backend." },
      { status: 503 },
    );
  }
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Body.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_body", message: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }

  // The instance-admin allowlist is by email, which only the auth server
  // can vouch for.
  const { data } = await getSupabaseForRequest(req).auth.getUser();
  try {
    const result = await createOrganizationForUser({
      userId: gated.userId,
      email: data.user?.email ?? null,
      name: parsed.data.name,
      slug: parsed.data.slug,
      workspaceName: parsed.data.workspace_name,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof OrgCreateError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
});
