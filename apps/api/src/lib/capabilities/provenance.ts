/**
 * Where a node came from, when it came from outside.
 *
 * A capability invocation is the gateway's receipt for one call to an
 * external tool (`capability_invocations`). When an agent saves what came back
 * as a node, the node carries the receipt in `data.provenance` and the receipt
 * points back at the node in `capability_invocations.node_id` — one column
 * whichever way the node was created: by hand through
 * `nodes_write(op=create, provenance)` or by accepting an ingest candidate
 * that a connector stamped with the same invocation id.
 */
import { z } from "zod";
import { supabaseConfigured } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const CapabilityProvenanceSchema = z.object({
  /** Capability key (the middle part of a `<provider>/<capability>/<tool>` ref) or id. */
  capability: z.string().trim().min(1).max(200),
  /** Remote tool name as the provider calls it. */
  tool: z.string().trim().min(1).max(200),
  /** `_meta.bcontext_gateway.invocation_id` from the tool result. */
  invocation_id: z.string().uuid(),
}).strict();
export type CapabilityProvenance = z.infer<typeof CapabilityProvenanceSchema>;

export interface StoredCapabilityProvenance extends CapabilityProvenance {
  source: "capability";
}

/** The shape stored under `node.data.provenance`. */
export function capabilityProvenanceData(input: CapabilityProvenance): StoredCapabilityProvenance {
  return {
    source: "capability",
    capability: input.capability,
    tool: input.tool,
    invocation_id: input.invocation_id,
  };
}

/**
 * Pull an invocation id out of an ingest candidate's free-form provenance, if
 * a connector left one there. Anything that is not a UUID is not a receipt.
 */
export function invocationIdFromProvenance(provenance: Record<string, unknown> | null | undefined): string | null {
  const raw = provenance?.invocation_id;
  return typeof raw === "string" && z.string().uuid().safeParse(raw).success ? raw : null;
}

export class CapabilityProvenanceError extends Error {
  constructor(public readonly code: "invocation_not_found" | "invocation_taken", message: string) {
    super(message);
    this.name = "CapabilityProvenanceError";
  }
}

/**
 * Check the receipt belongs to this workspace before a node is created with it.
 * Without Supabase (demo store, tests) there is no ledger to check against, so
 * the reference is accepted as given.
 */
export async function assertInvocationLinkable(workspaceId: string, invocationId: string): Promise<void> {
  if (!supabaseConfigured()) return;
  const { data, error } = await getSupabaseAdmin()
    .from("capability_invocations")
    .select("id,node_id")
    .eq("workspace_id", workspaceId)
    .eq("id", invocationId)
    .maybeSingle();
  if (error) throw new Error(`capability invocation lookup failed: ${error.message}`);
  if (!data) {
    throw new CapabilityProvenanceError(
      "invocation_not_found",
      `capability invocation ${invocationId} was not found in this workspace`,
    );
  }
  if (data.node_id) {
    throw new CapabilityProvenanceError(
      "invocation_taken",
      `capability invocation ${invocationId} is already linked to node ${String(data.node_id)}`,
    );
  }
}

/**
 * Point the invocation at the node it produced. Idempotent for the same node;
 * a receipt already claimed by another node is left alone (the first writer
 * wins, and `assertInvocationLinkable` reports it on the next create).
 */
export async function linkInvocationToNode(input: {
  workspaceId: string;
  invocationId: string;
  nodeId: string;
}): Promise<boolean> {
  if (!supabaseConfigured()) return false;
  const { data, error } = await getSupabaseAdmin()
    .from("capability_invocations")
    .update({ node_id: input.nodeId })
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.invocationId)
    .is("node_id", null)
    .select("id");
  if (error) {
    console.warn("[capability.provenance.link_failed]", error.message);
    return false;
  }
  return (data ?? []).length > 0;
}
