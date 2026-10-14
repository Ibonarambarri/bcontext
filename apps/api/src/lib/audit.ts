/**
 * Append-only audit log with per-workspace Merkle chain.
 *
 *   chain[0].prev_hash = GENESIS_HASH
 *   chain[i].prev_hash = chain[i-1].row_hash
 *   chain[i].row_hash  = sha256_hex(stable_json({ ...entry, prev_hash }))
 *
 * Tampering with any column on any row breaks the chain at that row and
 * every row after it. `verifyChain` walks the chain and reports the
 * first broken id.
 *
 * Writes go through the service-role client (audit_log INSERTs are
 * privileged); reads come back via RLS to workspace members.
 */
import { log } from "@bcontext-dev/contract/log";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { sha256Hex } from "@/lib/auth/tokens";
import { correlationId } from "@bcontext-dev/contract/correlation";

export const GENESIS_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

export type ActorType = "agent" | "user" | "system" | "demo";

export interface AuditEntryInput {
  workspaceId: string;
  actorType: ActorType;
  actorId?: string | null;
  agentTokenId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** Raw input — hashed at the boundary; never persisted in plaintext. */
  input?: unknown;
  /** Raw output — same treatment. */
  output?: unknown;
  /** Override correlation id; falls back to AsyncLocalStorage. */
  correlationId?: string | null;
}

export interface AuditRow {
  id: string;
  workspace_id: string;
  actor_type: ActorType;
  actor_id: string | null;
  agent_token_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  input_hash: string | null;
  output_hash: string | null;
  correlation_id: string | null;
  prev_hash: string;
  row_hash: string;
  ts: string;
}

/**
 * Append one audit entry. Fire-and-forget at call sites — the caller
 * passes `void appendAudit(...)` and we log errors here. Audit must
 * never break the write path.
 */
export async function appendAudit(input: AuditEntryInput): Promise<AuditRow | null> {
  try {
    return await appendAuditOrThrow(input);
  } catch (err) {
    // Twenty-two call sites fire this and do not await it. A failure here is
    // a missing audit row — bad, and logged as such — never a reason to take
    // the process down with an unhandled rejection.
    log.error("audit.append_failed", {
      workspace_id: input.workspaceId,
      action: input.action,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function appendAuditOrThrow(input: AuditEntryInput): Promise<AuditRow | null> {
  const sb = getSupabaseAdmin();
  const prev = await sb
    .from("audit_log")
    .select("row_hash")
    .eq("workspace_id", input.workspaceId)
    .order("ts", { ascending: false })
    .limit(1)
    .maybeSingle();
  const prevHash = (prev.data?.row_hash as string | undefined) ?? GENESIS_HASH;

  const inputHash = input.input != null ? await sha256OfStable(input.input) : null;
  const outputHash =
    input.output != null ? await sha256OfStable(input.output) : null;
  const corrId = input.correlationId ?? correlationId() ?? null;
  const ts = new Date().toISOString();

  const candidate: Omit<AuditRow, "id" | "row_hash"> = {
    workspace_id: input.workspaceId,
    actor_type: input.actorType,
    actor_id: input.actorId ?? null,
    agent_token_id: input.agentTokenId ?? null,
    action: input.action,
    target_type: input.targetType ?? null,
    target_id: input.targetId ?? null,
    input_hash: inputHash,
    output_hash: outputHash,
    correlation_id: corrId,
    prev_hash: prevHash,
    ts,
  };

  const rowHash = await computeRowHash(candidate);

  const { data, error } = await sb
    .from("audit_log")
    .insert({ ...candidate, row_hash: rowHash })
    .select("*")
    .single();
  if (error || !data) {
    // Best-effort: emit a warn line but never throw into the caller.
    // The caller's primary write already succeeded.
    // eslint-disable-next-line no-console
    console.warn("[audit.append.failed]", error?.message);
    return null;
  }
  return data as AuditRow;
}

/** Compute the canonical row_hash for a candidate row. Pure. */
export async function computeRowHash(
  row: Omit<AuditRow, "id" | "row_hash">,
): Promise<string> {
  const stable = stableJson(row);
  return sha256Hex(stable);
}

/**
 * Walk the chain for a workspace, returning the first row whose stored
 * row_hash disagrees with the locally-recomputed hash. `broken_at` is
 * the row id where the chain breaks, or null if the chain is intact.
 */
export async function verifyChain(workspaceId: string): Promise<{
  rows: number;
  broken_at: string | null;
  broken_reason?: string;
}> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("audit_log")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("ts", { ascending: true })
    .order("id", { ascending: true });
  if (error || !data) return { rows: 0, broken_at: null };

  return verifyChainPure(data as AuditRow[]);
}

/**
 * Pure verifier — takes a list and runs the chain check in memory.
 * Exposed for tests that want to seed a hand-crafted list.
 */
export async function verifyChainPure(rows: AuditRow[]): Promise<{
  rows: number;
  broken_at: string | null;
  broken_reason?: string;
}> {
  let expectedPrev = GENESIS_HASH;
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return {
        rows: rows.length,
        broken_at: row.id,
        broken_reason: `prev_hash mismatch: stored=${row.prev_hash.slice(0, 12)}…, expected=${expectedPrev.slice(0, 12)}…`,
      };
    }
    const recomputed = await computeRowHash({
      workspace_id: row.workspace_id,
      actor_type: row.actor_type,
      actor_id: row.actor_id,
      agent_token_id: row.agent_token_id,
      action: row.action,
      target_type: row.target_type,
      target_id: row.target_id,
      input_hash: row.input_hash,
      output_hash: row.output_hash,
      correlation_id: row.correlation_id,
      prev_hash: row.prev_hash,
      ts: row.ts,
    });
    if (recomputed !== row.row_hash) {
      return {
        rows: rows.length,
        broken_at: row.id,
        broken_reason: "row_hash mismatch — row body tampered",
      };
    }
    expectedPrev = row.row_hash;
  }
  return { rows: rows.length, broken_at: null };
}

// ---- Helpers ---------------------------------------------------------------

async function sha256OfStable(value: unknown): Promise<string> {
  return sha256Hex(stableJson(value));
}

export { sha256Hex };

/**
 * Deterministic JSON serialisation — object keys sorted recursively so
 * the same logical entry always hashes to the same string. JSON-safe
 * primitives only (no Date, no Set, no Map); throws on unsupported
 * types so a typo doesn't silently break the chain.
 *
 * `undefined` follows JSON.stringify: dropped as an object property, `null`
 * in an array, rejected at the top level. It used to throw everywhere, and an
 * optional field left unset in a tool's audit payload — the most ordinary
 * thing in JavaScript — took the API process down: appendAudit is fired and
 * forgotten, the rejection was unhandled, and Node exits on those.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, true));
}

function canonicalize(value: unknown, top = false): unknown {
  if (value === undefined) {
    if (top) throw new Error("stableJson: undefined not supported");
    return null;
  }
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("stableJson: non-finite number");
    }
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") {
    throw new Error("stableJson: bigint not supported");
  }
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (typeof value === "object") {
    // Reject Date, Map, Set, etc — only plain objects are allowed.
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
      throw new Error(`stableJson: unsupported ${name}`);
    }
    const o = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      if (o[k] === undefined) continue; // as JSON.stringify would
      sorted[k] = canonicalize(o[k]);
    }
    return sorted;
  }
  throw new Error(`stableJson: unsupported type ${typeof value}`);
}
