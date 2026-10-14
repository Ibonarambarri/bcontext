/**
 * CRUD on `connector_installs`. Pure data layer — no auth checks, no
 * webhook side-effects. Callers (routes, runtime) handle authorization.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { ConnectorId } from "@bcontext-dev/contract/connectors/types";

export type InstallStatus =
  | "pending"
  | "active"
  | "paused"
  | "errored"
  | "uninstalled";

export interface ConnectorInstall {
  id: string;
  workspace_id: string;
  connector_id: ConnectorId;
  config: Record<string, unknown>;
  secret_ref: string | null;
  status: InstallStatus;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export async function getInstall(
  workspaceId: string,
  connectorId: ConnectorId,
): Promise<ConnectorInstall | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("connector_installs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("connector_id", connectorId)
    .maybeSingle();
  if (error || !data) return null;
  return data as ConnectorInstall;
}

export async function getInstallById(id: string): Promise<ConnectorInstall | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("connector_installs")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return data as ConnectorInstall;
}

export async function upsertInstall(input: {
  workspaceId: string;
  connectorId: ConnectorId;
  config?: Record<string, unknown>;
  secretRef?: string | null;
  status?: InstallStatus;
}): Promise<ConnectorInstall> {
  const sb = getSupabaseAdmin();
  const row = {
    workspace_id: input.workspaceId,
    connector_id: input.connectorId,
    config: input.config ?? {},
    secret_ref: input.secretRef ?? null,
    status: input.status ?? "pending",
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await sb
    .from("connector_installs")
    .upsert(row, { onConflict: "workspace_id,connector_id" })
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`upsertInstall failed: ${error?.message ?? "no data"}`);
  }
  return data as ConnectorInstall;
}

export async function updateInstall(
  id: string,
  patch: Partial<{
    config: Record<string, unknown>;
    secret_ref: string | null;
    status: InstallStatus;
    last_sync_at: string;
    last_error: string | null;
  }>,
): Promise<void> {
  const sb = getSupabaseAdmin();
  await sb
    .from("connector_installs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
}

export async function listInstalls(
  workspaceId: string,
): Promise<ConnectorInstall[]> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("connector_installs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data as ConnectorInstall[];
}
