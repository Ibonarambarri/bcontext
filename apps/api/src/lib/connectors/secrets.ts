/**
 * Connector secret storage.
 *
 * Secrets are referenced indirectly via `connector_installs.secret_ref`
 * so the row itself is safe to read in dashboards. Resolution order:
 *
 *   vault:<id>      — Supabase Vault. Production path. Read/written via
 *                     service-role-only public RPC wrappers.
 *
 *   env:<NAME>      — read process.env[NAME]. Used for single-tenant
 *                     self-hosts where the secret lives next to the app.
 *
 *   inline:<b64>    — base64-encoded literal. Plaintext-equivalent;
 *                     reserved for tests and demo workspaces. Never
 *                     emit from production code.
 *
 * Writes go through `putSecret` which tries vault first and falls back
 * to env (read-only — returns the existing ref) or inline (dev only).
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@bcontext-dev/contract/log";

export type SecretRef = string;

const isProduction = () => process.env.NODE_ENV === "production";

export async function getSecret(ref: SecretRef | null): Promise<string | null> {
  if (!ref) return null;
  const colonAt = ref.indexOf(":");
  if (colonAt < 0) return null;
  const kind = ref.slice(0, colonAt);
  const value = ref.slice(colonAt + 1);

  switch (kind) {
    case "vault":
      return readVaultSecret(value);
    case "env": {
      const v = process.env[value];
      return v && v.length > 0 ? v : null;
    }
    case "inline": {
      if (isProduction()) {
        log.warn("connector.secret.inline_in_prod", { length: value.length });
      }
      try {
        return Buffer.from(value, "base64").toString("utf8");
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

/**
 * Persist a secret. In production prefers Supabase Vault; falls back to
 * `inline:<b64>` only when Vault is unreachable AND we're in dev.
 *
 * Returns the new secret_ref to store on connector_installs.
 */
export async function putSecret(opts: {
  workspaceId: string;
  connectorId: string;
  plaintext: string;
}): Promise<SecretRef> {
  return putNamedSecret({
    name: `connector:${opts.connectorId}:${opts.workspaceId}`,
    plaintext: opts.plaintext,
  });
}

/**
 * Persist or rotate a server-managed secret under a stable Vault name.
 * Reusing the name updates the existing Vault row and keeps its ref stable.
 */
export async function putNamedSecret(opts: {
  name: string;
  plaintext: string;
}): Promise<SecretRef> {
  const vaultRef = await writeVaultSecret(opts);
  if (vaultRef) return vaultRef;

  if (isProduction()) {
    // Don't silently downgrade to inline in prod — surface the failure.
    throw new Error(
      "connector secret storage unavailable: Vault write failed in production",
    );
  }
  return `inline:${Buffer.from(opts.plaintext, "utf8").toString("base64")}`;
}

/**
 * Delete a persisted Vault secret.
 *
 * Environment and inline refs are intentionally left untouched: an env var
 * belongs to the deployment, while inline refs do not have a backing record.
 * The boolean lets cleanup callers surface a Vault/RPC failure without ever
 * logging the secret id or plaintext.
 */
export async function deleteSecret(ref: SecretRef | null): Promise<boolean> {
  if (!ref) return false;
  const colonAt = ref.indexOf(":");
  if (colonAt < 0 || ref.slice(0, colonAt) !== "vault") return false;
  const id = ref.slice(colonAt + 1);
  if (!id) return false;

  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb.rpc("delete_vault_secret", {
      secret_id: id,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

async function readVaultSecret(id: string): Promise<string | null> {
  try {
    const sb = getSupabaseAdmin();
    const { data, error } = await sb.rpc("read_vault_secret", {
      secret_id: id,
    });
    if (error || typeof data !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

async function writeVaultSecret(opts: {
  name: string;
  plaintext: string;
}): Promise<SecretRef | null> {
  try {
    const sb = getSupabaseAdmin();
    // Public service-role RPC wraps vault.create_secret / vault.update_secret.
    const { data, error } = await sb.rpc("create_secret_or_update", {
      secret_value: opts.plaintext,
      secret_name: opts.name,
    });
    if (error || !data) return null;
    return `vault:${data}`;
  } catch {
    return null;
  }
}
