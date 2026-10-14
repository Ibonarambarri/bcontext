/**
 * A connector install as a principal of its own.
 *
 * `/bcontext search` in Slack runs authenticated by the install's HMAC, with no
 * person behind it, and anyone in the channel can trigger it. It used to run
 * as `systemGrant("slack install <id>")` — explicit and auditable, but total
 * access with nowhere to store anything narrower. This module gives the
 * install a `capability_principals` row (kind `service_account`, source
 * `connector_install`) and a `workspace_grants` row keyed to it, so an admin
 * can say "the Slack bot only sees finanzas" exactly as they would for an
 * agent: `admin_write op=grant principal {kind:"service_account", id}`.
 *
 * ## The default reach is a decision, not an inheritance
 *
 * A fresh install gets `{type:"all"}` with the single verb `read`. That is
 * what the system grant already did, so nothing changes for a channel on the
 * day it is installed — but it is written down as a row an admin can narrow,
 * and the install response says so in words (`describeInstallAccess`).
 *
 * ## Installs that predate this
 *
 * An install with no principal row (the migration not yet applied, or the
 * principal write failed) is reported as `unscoped`. The webhook keeps
 * answering with a system grant and logs a warning; refusing would break
 * every integration that exists today, and the anti-goal is explicit about
 * not doing that. The migration backfills a principal for every live Slack
 * install, so in practice this branch closes itself once it runs.
 *
 * Never the installing person's grant: that would hand the whole channel one
 * person's permissions while looking scoped, which is worse than the honest
 * system grant it replaces.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@bcontext-dev/contract/log";
import {
  hasVerb,
  isDenied,
  resolveGrantForPrincipal,
  type Denied,
  type Grant,
  type Reach,
  type Verb,
} from "./grants";

const SOURCE_TYPE = "connector_install";
const PRINCIPAL_KIND = "service_account";

/** The bot searches; it never writes. */
const INSTALL_VERBS: readonly Verb[] = ["read"];
const DEFAULT_INSTALL_REACH: Reach = { type: "all" };

export type InstallAccess =
  | {
      principal: { kind: "service_account"; id: string };
      reach: "all" | "narrowed" | "revoked";
      note: string;
    }
  | { principal: null; reach: "unscoped" | "unavailable"; note: string };

export interface ResolvedInstallGrant {
  /** `null` only when the principal could not be looked up; the grant then denies. */
  principalId: string | null;
  grant: Grant | Denied;
}

/**
 * Create (or re-enable) the install's principal and its grant. Idempotent: a
 * reinstall keeps a reach an admin already narrowed and lifts a revocation,
 * because installing is the act of admitting the bot — the same rule
 * `grant-sync` applies to accepting an invitation.
 *
 * Returns what the install can now see, or `null` when the rows could not be
 * written. The caller must go on regardless: the install itself must not fail
 * because its permission row did (the webhook has a fallback for exactly that).
 */
export async function ensureInstallPrincipal(input: {
  workspaceId: string;
  installId: string;
  displayName: string;
}): Promise<InstallAccess | null> {
  const fail = (op: string, message: string) => {
    log.error("install_principal.failed", {
      workspace_id: input.workspaceId,
      install_id: input.installId,
      op,
      error: message,
    });
    return null;
  };

  let admin;
  try {
    admin = getSupabaseAdmin();
  } catch (err) {
    return fail("client", err instanceof Error ? err.message : String(err));
  }

  const { data: principal, error: principalError } = await admin
    .from("capability_principals")
    .upsert(
      {
        workspace_id: input.workspaceId,
        kind: PRINCIPAL_KIND,
        source_type: SOURCE_TYPE,
        source_id: input.installId,
        display_name: input.displayName,
        disabled_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,source_type,source_id" },
    )
    .select("id")
    .single();
  if (principalError || !principal) {
    return fail("principal", principalError?.message ?? "no row");
  }
  const principalId = (principal as { id: string }).id;

  const { data: existing, error: readError } = await admin
    .from("workspace_grants")
    .select("reach")
    .eq("workspace_id", input.workspaceId)
    .eq("principal_kind", PRINCIPAL_KIND)
    .eq("principal_id", principalId)
    .maybeSingle();
  if (readError) return fail("read", readError.message);

  // A reach somebody chose survives a reinstall untouched; only a brand-new
  // install gets the documented default.
  const reach = ((existing as { reach?: Reach } | null)?.reach ?? DEFAULT_INSTALL_REACH) as Reach;

  const { error: grantError } = await admin.from("workspace_grants").upsert(
    {
      workspace_id: input.workspaceId,
      principal_kind: PRINCIPAL_KIND,
      principal_id: principalId,
      verbs: [...INSTALL_VERBS],
      reach,
      revoked_at: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,principal_kind,principal_id" },
  );
  if (grantError) return fail("grant", grantError.message);

  return describeInstallAccess({
    principalId,
    grant: { workspaceId: input.workspaceId, principal: { kind: PRINCIPAL_KIND, id: principalId }, verbs: INSTALL_VERBS, reach },
  });
}

/**
 * Uninstalling revokes rather than deletes, like every other revocation here:
 * who could search what, and until when, is what an incident review asks.
 */
export async function revokeInstallPrincipal(workspaceId: string, installId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  const found = await lookupPrincipalId(workspaceId, installId);
  if (!found.ok || !found.id) return;
  const principalId = found.id;

  const now = new Date().toISOString();
  const { error: grantError } = await admin
    .from("workspace_grants")
    .update({ revoked_at: now })
    .eq("workspace_id", workspaceId)
    .eq("principal_kind", PRINCIPAL_KIND)
    .eq("principal_id", principalId)
    .is("revoked_at", null);
  const { error: principalError } = await admin
    .from("capability_principals")
    .update({ disabled_at: now })
    .eq("id", principalId)
    .eq("workspace_id", workspaceId);
  const error = grantError ?? principalError;
  if (error) {
    log.error("install_principal.revoke_failed", {
      workspace_id: workspaceId,
      install_id: installId,
      error: error.message,
    });
  }
}

/**
 * The grant an install acts under, or `null` when it has no principal at all.
 *
 * `null` and `Denied` are different answers on purpose. `null` is "nothing was
 * ever written for this install" and the webhook may fall back to the old
 * system grant with a warning; `Denied` is "someone revoked it", and falling
 * back there would make revoking revoke nothing. A lookup *error* is a third
 * thing and must deny too: folding it into `null` would hand the bot the
 * whole workspace on a database hiccup, the fail-open `grants.ts` refuses.
 */
export async function resolveInstallGrant(
  workspaceId: string,
  installId: string,
): Promise<ResolvedInstallGrant | null> {
  const found = await lookupPrincipalId(workspaceId, installId);
  if (!found.ok) return { principalId: null, grant: { denied: "not_found" } };
  if (!found.id) return null;
  const grant = await resolveGrantForPrincipal({ kind: PRINCIPAL_KIND, id: found.id }, workspaceId);
  return { principalId: found.id, grant };
}

/** Words for the install response and the connectors screen. */
export function describeInstallAccess(resolved: ResolvedInstallGrant | null): InstallAccess {
  if (!resolved) {
    return {
      principal: null,
      reach: "unscoped",
      note:
        "This Slack install has no principal of its own yet, so the bot searches the whole workspace and cannot be narrowed. It gets one once the connector_install_principals migration has run.",
    };
  }
  if (resolved.principalId === null) {
    return {
      principal: null,
      reach: "unavailable",
      note: "The Slack bot's access could not be read right now; /bcontext search answers nothing until it can.",
    };
  }
  const principal = { kind: "service_account" as const, id: resolved.principalId };
  const { grant } = resolved;
  if (isDenied(grant) || !hasVerb(grant, "read")) {
    return {
      principal,
      reach: "revoked",
      note: "The Slack bot's access to this workspace is revoked: /bcontext search answers nothing until an admin grants it again.",
    };
  }
  if (grant.reach.type === "all") {
    return {
      principal,
      reach: "all",
      note:
        "By default the Slack bot can search everything in this workspace, for anyone in a channel where it is installed. An admin can narrow it to a set of tags with admin_write op=grant on this principal.",
    };
  }
  return {
    principal,
    reach: "narrowed",
    note: "The Slack bot searches only the part of the workspace its reach allows.",
  };
}

async function lookupPrincipalId(
  workspaceId: string,
  installId: string,
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("capability_principals")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("source_type", SOURCE_TYPE)
    .eq("source_id", installId)
    .is("disabled_at", null)
    .maybeSingle();
  if (error) {
    log.error("install_principal.lookup_failed", {
      workspace_id: workspaceId,
      install_id: installId,
      error: error.message,
    });
    return { ok: false };
  }
  return { ok: true, id: (data as { id: string } | null)?.id ?? null };
}
