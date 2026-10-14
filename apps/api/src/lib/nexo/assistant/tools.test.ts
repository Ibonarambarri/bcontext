import { describe, expect, test } from "vitest";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import {
  NEXO_CLIENT_TOOLS,
  NEXO_READ_TOOLS,
  NEXO_WRITE_TOOLS,
} from "@bcontext-dev/contract/nexo/assistant";
import type { Storage } from "@/lib/storage";
import { buildNexoTools } from "./tools";

const ISO = "2026-09-08T00:00:00.000Z";

function makeNode(overrides: Partial<KnowledgeNode>): KnowledgeNode {
  return {
    id: "n-1",
    workspace_id: "ws-1",
    parent_id: null,
    kind: "doc",
    slug: "n-1",
    title: "A doc",
    content_md: "## Goal\n\nMake it fast.\n\n## Notes\n\nMake it fast later.",
    data: {},
    tags: [],
    status: null,
    priority: null,
    assignee_id: null,
    due_date: null,
    position: 0,
    created_by: null,
    created_at: ISO,
    updated_at: ISO,
    ...overrides,
  };
}

/**
 * A storage stub holding one node in memory. Only the methods the tools under
 * test touch are real; the rest would throw if a tool reached for them, which
 * is the point — it keeps the test honest about what each tool does.
 */
function fakeStorage(node: KnowledgeNode) {
  const state = { node };
  const storage = {
    backend: "demo",
    workspace: { id: "ws-1", name: "Acme" },
    getNode: async (id: string) => (id === state.node.id ? state.node : null),
    updateNode: async (id: string, patch: Record<string, unknown>) => {
      if (id !== state.node.id) return null;
      state.node = { ...state.node, ...patch } as KnowledgeNode;
      return state.node;
    },
    createNode: async (input: Record<string, unknown>) =>
      makeNode({ id: "n-new", ...(input as Partial<KnowledgeNode>) }),
  } as unknown as Storage;
  return { storage, state };
}

function tools(node = makeNode({})) {
  const { storage, state } = fakeStorage(node);
  return {
    tools: buildNexoTools({ storage, workspaceRef: "acme/ws" }),
    state,
  };
}

describe("buildNexoTools", () => {
  test("exposes exactly the tools the contract names", () => {
    const names = Object.keys(tools().tools).sort();
    const expected = [
      ...NEXO_READ_TOOLS,
      ...NEXO_WRITE_TOOLS,
      ...NEXO_CLIENT_TOOLS,
    ].sort();
    expect(names).toEqual(expected);
  });

  test("replace_in_block edits one block and hands back the body for undo", async () => {
    const { tools: t, state } = tools();
    const result = await t.replace_in_block.execute!(
      {
        node_id: "n-1",
        block_id: "goal",
        find: "Make it fast.",
        replace: "Make it correct.",
        change_summary: "reworded the goal",
      },
      { toolCallId: "c1", messages: [] },
    );
    expect(result).toMatchObject({ ok: true, id: "n-1", summary: "reworded the goal" });
    // The undo payload is the body as it was, not as it is.
    expect((result as { before: string }).before).toContain("Make it fast.");
    expect(state.node.content_md).toContain("Make it correct.");
    // The identical sentence in ## Notes is untouched — block scoping is the
    // reason replace_in_block exists.
    expect(state.node.content_md).toContain("Make it fast later.");
  });

  test("replace_in_node refuses an ambiguous find instead of guessing", async () => {
    const { tools: t } = tools(
      makeNode({ content_md: "same line\nsame line" }),
    );
    const result = await t.replace_in_node.execute!(
      {
        node_id: "n-1",
        find: "same line",
        replace: "other",
        change_summary: "x",
      },
      { toolCallId: "c1", messages: [] },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("more than once");
  });

  test("replace_in_block names the current blocks when the id is wrong", async () => {
    const { tools: t } = tools();
    const result = await t.replace_in_block.execute!(
      {
        node_id: "n-1",
        block_id: "nope",
        find: "x",
        replace: "y",
        change_summary: "x",
      },
      { toolCallId: "c1", messages: [] },
    );
    expect((result as { error: string }).error).toContain("#goal");
  });

  test("`/n/` prefixes and `#` block ids are tolerated, not rejected", async () => {
    const { tools: t } = tools();
    const result = await t.read_block.execute!(
      { node_id: "/n/n-1", block_id: "#goal" },
      { toolCallId: "c1", messages: [] },
    );
    expect(result).toMatchObject({ ok: true, block_id: "goal" });
  });

  test("create_node keeps subtasks to the kinds that have them", async () => {
    const { tools: t } = tools();
    const result = await t.create_node.execute!(
      {
        kind: "doc",
        title: "A document",
        subtasks: [{ title: "step one", summary: "do it", content_md: "how" }],
      },
      { toolCallId: "c1", messages: [] },
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("task or bug");
  });

  test("create_node gives an actionable kind a status so it is not invisible", async () => {
    const { tools: t } = tools();
    const result = await t.create_node.execute!(
      { kind: "task", title: "Do the thing" },
      { toolCallId: "c1", messages: [] },
    );
    expect(result).toMatchObject({ ok: true, created: true });
  });

  test("client tools resolve locally without touching storage", async () => {
    const { tools: t } = tools();
    await expect(
      t.open_node.execute!(
        { node_id: "/n/n-404", block_id: "#goal" },
        { toolCallId: "c1", messages: [] },
      ),
    ).resolves.toEqual({ ok: true, node_id: "n-404", block_id: "goal" });
  });
});
