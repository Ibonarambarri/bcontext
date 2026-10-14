import { describe, expect, it } from "vitest";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { initialSkillData, skillVersion, withSkillVersionBump } from "./version";

const skill = (over: Partial<KnowledgeNode> = {}): KnowledgeNode =>
  ({ id: "s", kind: "skill", title: "S", content_md: "---\nname: s\n---\nold", data: { version: 3, source: "x" }, ...over }) as KnowledgeNode;

describe("skill version", () => {
  it("reads the integer version and treats anything else as v1", () => {
    expect(skillVersion({ version: 4 })).toBe(4);
    expect(skillVersion({ version: "4" })).toBe(1);
    expect(skillVersion({ version: 0 })).toBe(1);
    expect(skillVersion(undefined)).toBe(1);
    expect(initialSkillData({ source: "cat" })).toEqual({ source: "cat", version: 1 });
  });

  it("bumps only when a skill's body actually changes", () => {
    const node = skill();
    expect(withSkillVersionBump(node, { content_md: "---\nname: s\n---\nnew" })).toEqual({
      content_md: "---\nname: s\n---\nnew",
      data: { version: 4, source: "x" },
    });
    expect(withSkillVersionBump(node, { content_md: node.content_md })).toEqual({ content_md: node.content_md });
    expect(withSkillVersionBump(node, { title: "T" })).toEqual({ title: "T" });
    expect(withSkillVersionBump(skill({ kind: "doc" }), { content_md: "z" })).toEqual({ content_md: "z" });
    expect(withSkillVersionBump(null, { content_md: "z" })).toEqual({ content_md: "z" });
  });

  it("keeps a data patch the caller sent alongside the body", () => {
    const out = withSkillVersionBump(skill({ data: {} }), { content_md: "n", data: { tags_hint: 1 } });
    expect(out.data).toEqual({ tags_hint: 1, version: 2 });
  });
});
