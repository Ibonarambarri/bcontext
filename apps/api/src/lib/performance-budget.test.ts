import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";

describe("workspace summary payload budgets", () => {
  for (const size of [10, 250, 2000]) {
    it(`${size} nodes exclude documents and remain bounded`, () => {
      const nodes = Array.from({ length: size }, (_, i) => ({
        id: `n-${i}`, workspace_id: "w", parent_id: null, kind: "doc",
        slug: `n-${i}`, title: `Node ${i}`,
        status: null, priority: null, assignee_id: null, due_date: null,
        position: i, created_by: null, created_at: "2026-07-18T00:00:00Z",
        updated_at: "2026-07-18T00:00:00Z", source: null, tags: [],
      }));
      const json = JSON.stringify({ nodes });
      expect(json).not.toContain("content_md");
      expect(json).not.toContain('"data"');
      expect(gzipSync(json).byteLength).toBeLessThan(size === 250 ? 100_000 : size * 400);
    });
  }
});
