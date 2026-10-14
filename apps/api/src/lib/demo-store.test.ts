import { afterEach, describe, expect, test } from "vitest";
import {
  createNode,
  createWorkspace,
  getNode,
  updateNode,
} from "./demo-store";

let counter = 0;
function uniqueSlug(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

const created: string[] = [];
afterEach(() => {
  created.length = 0;
});

function makeWorkspace(name = "Block Test") {
  const slug = uniqueSlug("block-test");
  const ws = createWorkspace({ name, slug });
  created.push(ws.slug);
  return ws;
}

describe("updateNode — previous_block_ids[] tracking", () => {
  test("appends a removed H2's block_id when renamed", () => {
    const ws = makeWorkspace();
    const node = createNode(ws.slug, {
      title: "Spec",
      kind: "doc",
      parent_id: null,
      content_md: "## Vision\nbody\n\n## Auth\nbody",
    });
    const updated = updateNode(ws.slug, node.id, {
      content_md: "## New Vision\nbody\n\n## Auth\nbody",
    })!;
    expect(updated.data.previous_block_ids).toEqual(["vision"]);
  });

  test("does not touch previous_block_ids when no H2 disappears", () => {
    const ws = makeWorkspace();
    const node = createNode(ws.slug, {
      title: "Spec",
      kind: "doc",
      parent_id: null,
      content_md: "## Vision\nbody",
    });
    const updated = updateNode(ws.slug, node.id, {
      content_md: "## Vision\nbody plus extra paragraph",
    })!;
    expect(updated.data.previous_block_ids).toBeUndefined();
  });

  test("accumulates across multiple renames, dedupes", () => {
    const ws = makeWorkspace();
    const node = createNode(ws.slug, {
      title: "Spec",
      kind: "doc",
      parent_id: null,
      content_md: "## A\nbody\n\n## B\nbody",
    });
    let updated = updateNode(ws.slug, node.id, {
      content_md: "## A2\nbody\n\n## B\nbody",
    })!;
    expect(updated.data.previous_block_ids).toEqual(["a"]);
    updated = updateNode(ws.slug, node.id, {
      content_md: "## A2\nbody\n\n## B2\nbody",
    })!;
    expect(updated.data.previous_block_ids).toEqual(["a", "b"]);
    // Re-rename A2 → A3: a2 should be added; existing entries untouched.
    updated = updateNode(ws.slug, node.id, {
      content_md: "## A3\nbody\n\n## B2\nbody",
    })!;
    expect(updated.data.previous_block_ids).toEqual(["a", "b", "a2"]);
  });

  test("preserves an existing previous_slugs entry when content also changes", () => {
    const ws = makeWorkspace();
    const node = createNode(ws.slug, {
      title: "Old Title",
      kind: "doc",
      parent_id: null,
      content_md: "## Vision\nbody",
    });
    const updated = updateNode(ws.slug, node.id, {
      title: "New Title",
      content_md: "## New Vision\nbody",
    })!;
    expect(updated.data.previous_slugs).toContain(node.slug);
    expect(updated.data.previous_block_ids).toEqual(["vision"]);
  });

  test("getNode returns the persisted previous_block_ids", () => {
    const ws = makeWorkspace();
    const node = createNode(ws.slug, {
      title: "Spec",
      kind: "doc",
      parent_id: null,
      content_md: "## Vision\nbody",
    });
    updateNode(ws.slug, node.id, {
      content_md: "## V2\nbody",
    });
    const fetched = getNode(ws.slug, node.id)!;
    expect(fetched.data.previous_block_ids).toEqual(["vision"]);
  });
});
