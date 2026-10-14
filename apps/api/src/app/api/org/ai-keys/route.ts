/**
 * The organization's own model provider keys (BYOK).
 *
 *   GET    /api/org/ai-keys?org=<slug|id>                 → { keys: OrgAiKey[] }
 *   PUT    /api/org/ai-keys?org=<slug|id>  {provider, api_key}  → { key }
 *   DELETE /api/org/ai-keys?org=<slug|id>&provider=<p>    → { ok }
 *
 * Owners and admins of the organization only (`gateOrgAdmin`; anyone else
 * gets the same 404 a missing organization does). The key is write-only:
 * every response carries provider + last4, never the key. Storage is Vault
 * (`@/lib/nexos/org-ai-keys`). Audit rows are per workspace, so a key change
 * is logged, not audited.
 */
import { withRoute } from "@/lib/route";
import { log } from "@bcontext-dev/contract/log";
import { PutOrgAiKeyBodySchema } from "@bcontext-dev/contract/nexos";
import { gateOrgAdmin } from "@/lib/organizations/admin";
import { parseBody } from "@/lib/nexos/http";
import {
  deleteOrgAiKey,
  isOrgAiKeyProvider,
  listOrgAiKeys,
  OrgAiKeyStoreError,
  putOrgAiKey,
} from "@/lib/nexos/org-ai-keys";

function orgParam(req: Request): string | null {
  return new URL(req.url).searchParams.get("org")?.trim() || null;
}

export const GET = withRoute(async (req: Request) => {
  const gated = await gateOrgAdmin(req, orgParam(req));
  if (gated instanceof Response) return gated;
  return Response.json({ keys: await listOrgAiKeys(gated.org.id) });
});

export const PUT = withRoute(async (req: Request) => {
  const body = await parseBody(req, PutOrgAiKeyBodySchema);
  if (body instanceof Response) return body;
  const gated = await gateOrgAdmin(req, orgParam(req));
  if (gated instanceof Response) return gated;
  try {
    const key = await putOrgAiKey({
      orgId: gated.org.id,
      provider: body.provider,
      apiKey: body.api_key,
      userId: gated.actor.userId,
    });
    log.info("org.ai_key.put", { organization_id: gated.org.id, provider: body.provider, user_id: gated.actor.userId });
    return Response.json({ key });
  } catch (err) {
    if (err instanceof OrgAiKeyStoreError) {
      return Response.json({ error: err.code, message: err.message }, { status: 503 });
    }
    throw err;
  }
});

export const DELETE = withRoute(async (req: Request) => {
  const provider = new URL(req.url).searchParams.get("provider");
  if (!isOrgAiKeyProvider(provider)) {
    return Response.json({ error: "invalid_provider" }, { status: 400 });
  }
  const gated = await gateOrgAdmin(req, orgParam(req));
  if (gated instanceof Response) return gated;
  const removed = await deleteOrgAiKey(gated.org.id, provider);
  if (!removed) return Response.json({ error: "key_not_found" }, { status: 404 });
  log.info("org.ai_key.delete", { organization_id: gated.org.id, provider, user_id: gated.actor.userId });
  return Response.json({ ok: true });
});
