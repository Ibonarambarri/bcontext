/**
 * Where a capability connection's static credential lives (auth `bearer` /
 * `header`): Supabase Vault, through the same service-role RPC wrappers the
 * connectors and managed OAuth use (`@/lib/connectors/secrets`). The
 * connection row only ever carries a `vault:<uuid>` reference — the database
 * check constraint refuses anything else — so a customer pastes the token
 * once in the product and no operator ever sees it or sets an env var.
 *
 * Called by the register paths (REST `POST /api/capabilities`, MCP
 * `capabilities_write(op=connect)`) and the provider update route before
 * they write the connection. Cleanup of a replaced or removed reference is
 * the database's job (triggers on `capability_connections`, migration 0091);
 * callers only delete a reference they stored and then failed to persist.
 *
 * Must not change: every write gets a fresh Vault row. Reusing a name would
 * overwrite the live credential before the row update commits, so a stale
 * lock or a bundle pin refusing the update would leave the old connection
 * pointing at the new secret.
 */
import { randomUUID } from "node:crypto";
import { deleteSecret, putNamedSecret, type SecretRef } from "@/lib/connectors/secrets";

const VAULT_REF = /^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Thrown when Vault cannot take the credential; the caller answers 503-ish and stores nothing. */
export class ConnectionSecretError extends Error {
  readonly code = "credential_store_unavailable";
  constructor() {
    super("The credential could not be stored; nothing was saved. Try again.");
    this.name = "ConnectionSecretError";
  }
}

/**
 * Store the pasted token and return the `vault:<uuid>` reference to persist
 * on `capability_connections.secret_ref`. Never logs or returns the token.
 */
export async function storeConnectionSecret(opts: { workspaceId: string; plaintext: string }): Promise<SecretRef> {
  let ref: SecretRef;
  try {
    ref = await putNamedSecret({
      name: `capability-connection:${opts.workspaceId}:${randomUUID()}`,
      plaintext: opts.plaintext,
    });
  } catch {
    throw new ConnectionSecretError();
  }
  // Outside production the connector store degrades to an inline ref; the
  // connection table refuses those, so fail here with a clear reason instead.
  if (!VAULT_REF.test(ref)) throw new ConnectionSecretError();
  return ref;
}

/** Drop a reference this process stored but could not attach to a row. */
export async function discardConnectionSecret(ref: SecretRef | null | undefined): Promise<void> {
  if (!ref) return;
  await deleteSecret(ref).catch(() => false);
}
