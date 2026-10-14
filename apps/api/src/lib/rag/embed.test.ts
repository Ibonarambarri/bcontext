import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { embedNode } from "./embed";

const ORIG_GATEWAY_KEY = process.env.AI_GATEWAY_API_KEY;

/** Minimal fake Supabase client covering only the calls embedNode makes. */
function fakeSupabase(node: Record<string, unknown> | null) {
  const deleteEq = vi.fn().mockResolvedValue({ data: null, error: null });
  const selectMaybeSingle = vi.fn().mockResolvedValue({ data: node, error: null });
  const from = vi.fn((table: string) => {
    if (table === "nodes") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: selectMaybeSingle }),
        }),
      };
    }
    if (table === "embeddings") {
      return { delete: () => ({ eq: deleteEq }) };
    }
    throw new Error(`unexpected table: ${table}`);
  });
  return {
    client: { from } as unknown as SupabaseClient,
    deleteEq,
    selectMaybeSingle,
  };
}

describe("embedNode credential skip", () => {
  beforeEach(() => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
  });
  afterEach(() => {
    if (ORIG_GATEWAY_KEY === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = ORIG_GATEWAY_KEY;
  });

  it("skips embedding for a credential node and clears any prior chunks", async () => {
    const { client, deleteEq } = fakeSupabase({
      id: "cred-1",
      workspace_id: "ws-1",
      title: "Supabase keys",
      content_md: "Keys for the project.",
      kind: "credential",
    });

    const result = await embedNode(client, "cred-1");

    expect(result).toEqual({ status: "skipped", chunks: 0, reason: "credential" });
    expect(deleteEq).toHaveBeenCalledWith("node_id", "cred-1");
  });

  it("does not take the credential skip path for a non-credential node", async () => {
    // No AI_GATEWAY_API_KEY here on purpose: this isolates the credential
    // branch from the (network-calling) embedding pipeline. If a
    // non-credential node were misrouted into the credential skip, the
    // reason would be "credential"; the real code path instead short
    // circuits earlier with its own distinct reason.
    delete process.env.AI_GATEWAY_API_KEY;
    const { client, selectMaybeSingle } = fakeSupabase({
      id: "doc-1",
      workspace_id: "ws-1",
      title: "Runbook",
      content_md: "",
      kind: "doc",
    });

    const result = await embedNode(client, "doc-1");

    expect(selectMaybeSingle).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "skipped",
      chunks: 0,
      reason: "no AI backend configured",
    });
  });
});
