import { describe, expect, test } from "vitest";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { PageContext } from "@bcontext-dev/contract/nexo/assistant";
import { buildNexoMessages, NEIGHBOURHOOD_MAX_NODES } from "./prompt";

const ISO = "2026-09-08T00:00:00.000Z";

function makeNode(overrides: Partial<KnowledgeNode>): KnowledgeNode {
  return {
    id: "node-base",
    workspace_id: "ws-1",
    parent_id: null,
    kind: "doc",
    slug: "node-base",
    title: "Base node",
    content_md: "",
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

const nodes: KnowledgeNode[] = [
  makeNode({ id: "n-vision", title: "Product vision", slug: "product-vision" }),
  makeNode({ id: "n-task", title: "Ship caching", slug: "ship-caching", kind: "task" }),
];

const ask = [{ role: "user" as const, content: "what is this?" }];

function systemBlocks(messages: ReturnType<typeof buildNexoMessages>): string[] {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""));
}

describe("buildNexoMessages", () => {
  test("two cache markers: the static block and the last system block", () => {
    const messages = buildNexoMessages({
      workspaceName: "Acme",
      nodes,
      openNode: nodes[0]!,
      pageContext: { route: "/w/acme/ws", surface: "widget" },
      userMessages: ask,
    });
    const cached = messages.filter((m) => m.providerOptions?.anthropic);
    expect(cached).toHaveLength(2);
    expect(cached[0]).toBe(messages[0]);
    // The second marker closes the dynamic prefix so the tool steps of one
    // turn read it from cache; it sits on the last system message, right
    // before the conversation.
    const systemMessages = messages.filter((m) => m.role === "system");
    expect(cached[1]).toBe(systemMessages[systemMessages.length - 1]);
    expect(messages.filter((m) => m.role !== "system").some((m) => m.providerOptions)).toBe(false);
  });

  test("with nothing dynamic, only the static block is marked", () => {
    const messages = buildNexoMessages({
      workspaceName: "Acme",
      nodes: [],
      openNode: null,
      pageContext: null,
      userMessages: ask,
    });
    const cached = messages.filter((m) => m.providerOptions?.anthropic);
    expect(cached).toHaveLength(1);
    expect(cached[0]).toBe(messages[0]);
  });

  test("the cached block carries no nodes, so it survives navigation", () => {
    const messages = buildNexoMessages({
      workspaceName: "Acme",
      nodes,
      openNode: nodes[0]!,
      pageContext: { route: "/w/acme/ws" },
      userMessages: ask,
    });
    const staticBlock = systemBlocks(messages)[0];
    // The whole point of the rewrite: the graph moved out of the cached prefix.
    expect(staticBlock).not.toContain("n-vision");
    expect(staticBlock).not.toContain("Product vision");
    expect(staticBlock).toContain("search_nodes");
  });

  test("the cached block budgets output: open, one line, ask — never summarise", () => {
    const messages = buildNexoMessages({
      workspaceName: "Acme",
      nodes,
      openNode: null,
      pageContext: null,
      userMessages: ask,
    });
    const staticBlock = systemBlocks(messages)[0]!;
    expect(staticBlock).toContain("## How much to say");
    expect(staticBlock).toContain("Do NOT summarise or reproduce the body");
    expect(staticBlock).toContain("Depth on request, never by default");
    // Nodes are named as links the interface can open, in GFM the panel renders.
    expect(staticBlock).toContain("## Markdown");
    expect(staticBlock).toContain("[Title](/n/<id>)");
  });

  test("the prompt forbids the em dash and does not model one itself", () => {
    const messages = buildNexoMessages({
      workspaceName: "Acme",
      nodes,
      openNode: nodes[0]!,
      pageContext: { route: "/w/acme/ws", surface: "widget", open_node: { id: "n-vision" } },
      userMessages: ask,
    });
    const blocks = systemBlocks(messages);
    expect(blocks[0]).toContain("Never use the em dash");
    // The model copies what it reads: the only dash in the whole prompt is
    // the one inside the rule that names it.
    const dashes = blocks.join("\n").match(/[—–]/g) ?? [];
    expect(dashes).toHaveLength(2);
  });

  test("retrieval hits are material to answer from, not a list to hand back", () => {
    const messages = buildNexoMessages({
      workspaceName: "Acme",
      nodes,
      openNode: null,
      pageContext: null,
      userMessages: ask,
      ragContext: {
        hits: [
          {
            node_id: "n-vision",
            title: "Product vision",
            kind: "doc",
            content: "We sell shovels.",
            block_id: "goal",
          } as never,
        ],
        scope: { type: "workspace", size: 2, workspace_size: 2 } as never,
      },
    });
    const rag = systemBlocks(messages).find((b) => b.startsWith("## Retrieval"));
    expect(rag).toBeDefined();
    expect(rag).toContain("not a list to hand back");
    expect(rag).toContain("We sell shovels.");
  });

  test("page context is its own uncached block and names the open node", () => {
    const pageContext: PageContext = {
      surface: "widget",
      route: "/w/acme/ws/views/tasks",
      view: { slug: "tasks", label: "Tasks", renderer: "board" },
      open_node: { id: "n-vision", block_id: "goal", surface: "panel" },
    };
    const messages = buildNexoMessages({
      workspaceName: "Acme",
      nodes,
      openNode: nodes[0]!,
      pageContext,
      userMessages: ask,
    });
    const blocks = systemBlocks(messages);
    const page = blocks.find((b) => b.startsWith("## Page context"));
    expect(page).toBeDefined();
    expect(page).toContain("/w/acme/ws/views/tasks");
    expect(page).toContain("Tasks");
    expect(page).toContain("/n/n-vision");
    expect(page).toContain("#goal");
    // It changes on every navigation, so it must never be the cached one.
    const pageMessage = messages.find(
      (m) => typeof m.content === "string" && m.content.startsWith("## Page context"),
    );
    expect(pageMessage?.providerOptions).toBeUndefined();
  });

  test("a selection is quoted verbatim and told to be used as the find string", () => {
    const messages = buildNexoMessages({
      workspaceName: "Acme",
      nodes,
      openNode: nodes[0]!,
      pageContext: {
        selection: { text: "the quick brown fox", node_id: "n-vision", block_id: "goal" },
      },
      userMessages: [{ role: "user", content: "rewrite this" }],
    });
    const page = systemBlocks(messages).find((b) => b.startsWith("## Page context"));
    expect(page).toContain("the quick brown fox");
    expect(page).toContain("replace_in_block");
  });

  test("no page context at all leaves the block out entirely", () => {
    const messages = buildNexoMessages({
      workspaceName: "Acme",
      nodes,
      openNode: null,
      pageContext: null,
      userMessages: ask,
    });
    expect(systemBlocks(messages).some((b) => b.startsWith("## Page context"))).toBe(
      false,
    );
  });

  test("the open node body is a separate block, not folded into the map", () => {
    const openNode = makeNode({
      id: "n-open",
      title: "Open one",
      content_md: "## Goal\n\nSecret body text.",
    });
    const messages = buildNexoMessages({
      workspaceName: "Acme",
      nodes: [...nodes, openNode],
      openNode,
      pageContext: { open_node: { id: "n-open" } },
      userMessages: ask,
    });
    const blocks = systemBlocks(messages);
    expect(blocks[0]).not.toContain("Secret body text");
    expect(
      blocks.some(
        (b) => b.startsWith("## Open node body") && b.includes("Secret body text"),
      ),
    ).toBe(true);
  });

  test("the nearby graph is capped, however many nodes it is handed", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      makeNode({ id: `n-${i}`, title: `Node ${i}`, slug: `node-${i}` }),
    );
    const messages = buildNexoMessages({
      workspaceName: "Acme",
      nodes: many,
      openNode: many[0]!,
      pageContext: null,
      userMessages: ask,
    });
    const graph = systemBlocks(messages).find((b) => b.startsWith("## Nearby graph"));
    expect(graph).toBeDefined();
    const listed = (graph!.match(/\/n\/n-\d+/g) ?? []).length;
    expect(listed).toBeLessThanOrEqual(NEIGHBOURHOOD_MAX_NODES);
  });

  test("user messages are passed through verbatim and last", () => {
    const userMessages = [
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "reply" },
      { role: "user" as const, content: "second" },
    ];
    const messages = buildNexoMessages({
      workspaceName: "Acme",
      nodes,
      openNode: null,
      pageContext: null,
      userMessages,
    });
    expect(messages.slice(-3)).toEqual(userMessages);
  });
});
