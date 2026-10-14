import { describe, it, expect } from "vitest";
import { extractSkills, generate, parseSkillNode } from "./generate";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";

function makeNode(
  id: string,
  title: string,
  content_md: string,
): KnowledgeNode {
  return {
    id,
    workspace_id: "ws",
    parent_id: null,
    kind: "doc",
    slug: id,
    title,
    content_md,
    data: {},
    tags: [],
    status: null,
    priority: null,
    assignee_id: null,
    due_date: null,
    position: 0,
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const SKILL_BODY = `---
name: weekly_review
description: Generate a weekly recap.
---

Read the workspace activity from the last 7 days and produce a 3-section recap.`;

describe("parseSkillNode", () => {
  it("returns null for a node without frontmatter", () => {
    const n = makeNode("a", "Plain doc", "Just some prose.");
    expect(parseSkillNode(n)).toBeNull();
  });

  it("returns null for frontmatter missing the name field", () => {
    const n = makeNode("b", "Missing name", "---\ndescription: x\n---\n\nbody");
    expect(parseSkillNode(n)).toBeNull();
  });

  it("parses name + description + body", () => {
    const n = makeNode("c", "Weekly", SKILL_BODY);
    const skill = parseSkillNode(n);
    expect(skill).not.toBeNull();
    expect(skill?.name).toBe("weekly_review");
    expect(skill?.description).toBe("Generate a weekly recap.");
    expect(skill?.body).toContain("Read the workspace activity");
    expect(skill?.source_id).toBe("c");
  });
});

describe("extractSkills", () => {
  it("filters to skill-shaped nodes only", () => {
    const nodes = [
      makeNode("plain", "Plain", "no frontmatter"),
      makeNode("skill", "Skill", SKILL_BODY),
    ];
    const skills = extractSkills(nodes);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("weekly_review");
  });

  it("works for nodes whose kind is the dedicated 'skill' kind", () => {
    // Sanity check that P1-06's new NodeKind doesn't change the
    // frontmatter-based extraction contract.
    const n = makeNode("k", "Weekly", SKILL_BODY);
    n.kind = "skill";
    const skills = extractSkills([n]);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.source_id).toBe("k");
  });
});

describe("generate", () => {
  const skills = extractSkills([makeNode("c", "Weekly", SKILL_BODY)]);

  it("renders AGENTS.md with workspace name", () => {
    const out = generate("agents-md", skills, { workspaceName: "Acme" });
    expect(out).toContain("# AGENTS.md");
    expect(out).toContain("Acme");
    expect(out).toContain("## weekly_review");
    expect(out).toContain("Generate a weekly recap.");
    expect(out).toContain("reusable workspace tags");
    expect(out).toContain("never grant access or replace workspace RLS");
    expect(out).toContain("`folder` and `category` are not node fields");
  });

  it("renders an empty-state notice when no skills", () => {
    expect(generate("agents-md", [])).toContain("No skills defined yet.");
  });

  it("renders Cursor rules with description frontmatter", () => {
    const out = generate("cursor-rules", skills);
    expect(out).toContain("description: Generate a weekly recap.");
    expect(out).toContain("alwaysApply: false");
  });
});
