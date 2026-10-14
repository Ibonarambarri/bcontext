import { describe, expect, it } from "vitest";
import {
  GENESIS_HASH,
  computeRowHash,
  stableJson,
  verifyChainPure,
  type AuditRow,
} from "./audit";

describe("audit — stableJson", () => {
  it("sorts object keys recursively", () => {
    const a = stableJson({ b: 1, a: 2, nested: { y: 1, x: 2 } });
    const b = stableJson({ a: 2, b: 1, nested: { x: 2, y: 1 } });
    expect(a).toBe(b);
  });

  it("preserves array order (semantics are different)", () => {
    expect(stableJson([3, 1, 2])).toBe("[3,1,2]");
    expect(stableJson([3, 1, 2])).not.toBe(stableJson([1, 2, 3]));
  });

  it("rejects unsupported types", () => {
    expect(() => stableJson(new Date())).toThrow();
    expect(() => stableJson(undefined as unknown)).toThrow();
    expect(() => stableJson(BigInt(1) as unknown)).toThrow();
  });

  it("rejects non-finite numbers", () => {
    expect(() => stableJson(Number.NaN)).toThrow();
    expect(() => stableJson(Number.POSITIVE_INFINITY)).toThrow();
  });
});

async function buildChain(n: number, workspaceId = "ws-1"): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];
  let prev = GENESIS_HASH;
  for (let i = 0; i < n; i++) {
    const body: Omit<AuditRow, "id" | "row_hash"> = {
      workspace_id: workspaceId,
      actor_type: "user",
      actor_id: "u-1",
      agent_token_id: null,
      action: `node.create#${i}`,
      target_type: "node",
      target_id: `n-${i}`,
      input_hash: null,
      output_hash: null,
      correlation_id: null,
      prev_hash: prev,
      ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    };
    const row_hash = await computeRowHash(body);
    rows.push({ id: `row-${i}`, row_hash, ...body });
    prev = row_hash;
  }
  return rows;
}

describe("audit — chain verification", () => {
  it("10 valid entries verify intact", async () => {
    const chain = await buildChain(10);
    const result = await verifyChainPure(chain);
    expect(result).toEqual({ rows: 10, broken_at: null });
  });

  it("tampering with row 5 breaks the chain at row 5", async () => {
    const chain = await buildChain(10);
    // Mutate the body of row 5 without recomputing the row_hash.
    chain[5]!.action = "tampered_action";
    const result = await verifyChainPure(chain);
    expect(result.broken_at).toBe("row-5");
    expect(result.broken_reason).toMatch(/row_hash mismatch/);
    expect(result.rows).toBe(10);
  });

  it("tampering with prev_hash on row 7 breaks at row 7", async () => {
    const chain = await buildChain(10);
    chain[7]!.prev_hash = GENESIS_HASH;
    const result = await verifyChainPure(chain);
    expect(result.broken_at).toBe("row-7");
    expect(result.broken_reason).toMatch(/prev_hash mismatch/);
  });

  it("first row's prev_hash must be GENESIS_HASH", async () => {
    const chain = await buildChain(3);
    chain[0]!.prev_hash = "deadbeef";
    const result = await verifyChainPure(chain);
    expect(result.broken_at).toBe("row-0");
    expect(result.broken_reason).toMatch(/prev_hash mismatch/);
  });

  it("empty workspace verifies as intact", async () => {
    const result = await verifyChainPure([]);
    expect(result).toEqual({ rows: 0, broken_at: null });
  });

  it("changes propagate: tampering row 3 still reports row 3 (earliest break)", async () => {
    const chain = await buildChain(8);
    chain[3]!.action = "tampered";
    const result = await verifyChainPure(chain);
    expect(result.broken_at).toBe("row-3");
  });
});

describe("stableJson and undefined", () => {
  it("follows JSON.stringify: dropped in objects, null in arrays, rejected at the top", () => {
    // An optional tool field left unset used to throw here — and, fired and
    // forgotten by the handler, take the whole API process down.
    expect(stableJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableJson({ list: [undefined, 2] })).toBe('{"list":[null,2]}');
    expect(() => stableJson(undefined)).toThrow(/undefined/);
  });
});
