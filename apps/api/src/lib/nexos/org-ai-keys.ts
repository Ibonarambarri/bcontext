/**
 * Bring-your-own-key: an organization's own model provider key, which then
 * pays for its Nexos' calls instead of our metered access.
 *
 * The key lives in Supabase Vault through the same service-role wrappers the
 * connectors and capability connections use (`@/lib/connectors/secrets`);
 * the `organization_ai_keys` row keeps only the `vault:<uuid>` reference and
 * the last four characters. Every write stores a fresh Vault entry and the
 * row's triggers (0096) delete the replaced one, so a failed write never
 * overwrites the live key. Without Supabase (demo, tests) keys live in memory.
 *
 * Callers: `GET/PUT/DELETE /api/org/ai-keys` (admin only; they only ever see
 * `OrgAiKey` — provider + last4) and the runtime's model resolution
 * (`resolveOrgAiKey`, the only function that returns plaintext; server-only,
 * never logged, never returned over HTTP).
 */
import { randomUUID } from "node:crypto";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { ORG_AI_KEY_PROVIDERS, type OrgAiKey, type OrgAiKeyProvider } from "@bcontext-dev/contract/nexos";
import { deleteSecret, getSecret, putNamedSecret } from "@/lib/connectors/secrets";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const VAULT_REF = /^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Vault could not take the key; nothing was stored. */
export class OrgAiKeyStoreError extends Error {
  readonly code = "credential_store_unavailable";
  constructor() {
    super("The key could not be stored; nothing was saved. Try again.");
    this.name = "OrgAiKeyStoreError";
  }
}

interface MemKey extends OrgAiKey {
  plaintext: string;
}
const memKeys = new Map<string, MemKey>();
const memKey = (orgId: string, provider: OrgAiKeyProvider) => `${orgId}:${provider}`;

/** Test seam. */
export function resetOrgAiKeysForTests(): void {
  memKeys.clear();
}

export function last4(apiKey: string): string {
  return apiKey.trim().slice(-4);
}

function toPublic(row: Record<string, unknown>): OrgAiKey {
  return {
    provider: row.provider as OrgAiKeyProvider,
    last4: String(row.last4 ?? ""),
    created_by: typeof row.created_by === "string" ? row.created_by : null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? row.created_at ?? ""),
  };
}

/** The organization's keys, provider + last4 only. */
export async function listOrgAiKeys(orgId: string): Promise<OrgAiKey[]> {
  if (!isSupabaseConfigured()) {
    return [...memKeys.entries()]
      .filter(([k]) => k.startsWith(`${orgId}:`))
      .map(([, { plaintext: _secret, ...rest }]) => rest);
  }
  const { data, error } = await getSupabaseAdmin()
    .from("organization_ai_keys")
    .select("provider,last4,created_by,created_at,updated_at")
    .eq("organization_id", orgId)
    .order("provider", { ascending: true });
  if (error) throw new Error(`org_ai_keys.list: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map(toPublic);
}

/** Store or replace the key for one provider. */
export async function putOrgAiKey(input: {
  orgId: string;
  provider: OrgAiKeyProvider;
  apiKey: string;
  userId: string | null;
}): Promise<OrgAiKey> {
  const apiKey = input.apiKey.trim();
  const at = new Date().toISOString();
  if (!isSupabaseConfigured()) {
    const prev = memKeys.get(memKey(input.orgId, input.provider));
    const row: MemKey = {
      provider: input.provider,
      last4: last4(apiKey),
      created_by: input.userId,
      created_at: prev?.created_at ?? at,
      updated_at: at,
      plaintext: apiKey,
    };
    memKeys.set(memKey(input.orgId, input.provider), row);
    const { plaintext: _secret, ...rest } = row;
    return rest;
  }

  let ref: string;
  try {
    ref = await putNamedSecret({
      name: `org-ai-key:${input.orgId}:${input.provider}:${randomUUID()}`,
      plaintext: apiKey,
    });
  } catch {
    throw new OrgAiKeyStoreError();
  }
  // Outside production the secret store degrades to an inline ref, which the
  // table refuses; fail with a clear reason instead of a constraint error.
  if (!VAULT_REF.test(ref)) throw new OrgAiKeyStoreError();

  const { data, error } = await getSupabaseAdmin()
    .from("organization_ai_keys")
    .upsert(
      {
        organization_id: input.orgId,
        provider: input.provider,
        secret_ref: ref,
        last4: last4(apiKey),
        created_by: input.userId,
      },
      { onConflict: "organization_id,provider" },
    )
    .select("provider,last4,created_by,created_at,updated_at")
    .single();
  if (error || !data) {
    await deleteSecret(ref).catch(() => false);
    throw new Error(`org_ai_keys.put: ${error?.message ?? "no row"}`);
  }
  return toPublic(data as Record<string, unknown>);
}

/** Remove one provider's key. The Vault entry goes with the row (trigger). */
export async function deleteOrgAiKey(orgId: string, provider: OrgAiKeyProvider): Promise<boolean> {
  if (!isSupabaseConfigured()) return memKeys.delete(memKey(orgId, provider));
  const { data, error } = await getSupabaseAdmin()
    .from("organization_ai_keys")
    .delete()
    .eq("organization_id", orgId)
    .eq("provider", provider)
    .select("id");
  if (error) throw new Error(`org_ai_keys.delete: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * The plaintext key the runtime should call with, or null when the
 * organization has none (use our metered access). With `preferred`, that
 * provider only; otherwise the first of gateway → anthropic → openai, because
 * a gateway key can serve every model the default config names.
 */
export async function resolveOrgAiKey(
  orgId: string,
  preferred?: OrgAiKeyProvider,
): Promise<{ provider: OrgAiKeyProvider; apiKey: string } | null> {
  const order: OrgAiKeyProvider[] = preferred ? [preferred] : ["gateway", "anthropic", "openai"];
  if (!isSupabaseConfigured()) {
    for (const p of order) {
      const k = memKeys.get(memKey(orgId, p));
      if (k) return { provider: p, apiKey: k.plaintext };
    }
    return null;
  }
  const { data, error } = await getSupabaseAdmin()
    .from("organization_ai_keys")
    .select("provider,secret_ref")
    .eq("organization_id", orgId)
    .in("provider", order);
  if (error) throw new Error(`org_ai_keys.resolve: ${error.message}`);
  const rows = (data ?? []) as Array<{ provider: string; secret_ref: string }>;
  for (const p of order) {
    const row = rows.find((r) => r.provider === p);
    if (!row) continue;
    const apiKey = await getSecret(row.secret_ref);
    if (apiKey) return { provider: p, apiKey };
  }
  return null;
}

export function isOrgAiKeyProvider(value: unknown): value is OrgAiKeyProvider {
  return typeof value === "string" && (ORG_AI_KEY_PROVIDERS as readonly string[]).includes(value);
}
