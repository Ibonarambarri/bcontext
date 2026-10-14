import { describe, expect, it } from "vitest";
import { parseSkillBody, splitFrontmatter } from "@/lib/skills/frontmatter";

const STARTER = `---
title: Triage inbox
input_schema:
  fields:
    - name: nodes_dump
      type: string
      required: true
      description: Recent unsorted nodes as a flat list (title, kind, snippet).
    - name: available_tags
      type: string
      required: false
      default: business, product, tech, ai
system: |
  You are a workspace triage assistant. Your job is to classify each
  inbound node into the right kind.
  Never invent metadata you can't justify from the snippet.
---

You are looking at unsorted nodes from a Bcontext workspace.

{{nodes_dump}}
`;

describe("skill frontmatter", () => {
  it("reads the starter skill shape: title, fields, system, body", () => {
    const parsed = parseSkillBody(STARTER);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter.title).toBe("Triage inbox");
    expect(parsed.frontmatter.fields).toEqual([
      {
        name: "nodes_dump",
        type: "string",
        required: true,
        description: "Recent unsorted nodes as a flat list (title, kind, snippet).",
      },
      { name: "available_tags", type: "string", required: false, default: "business, product, tech, ai" },
    ]);
    expect(parsed.frontmatter.system).toBe(
      "You are a workspace triage assistant. Your job is to classify each\ninbound node into the right kind.\nNever invent metadata you can't justify from the snippet.\n",
    );
    expect(parsed.body.startsWith("You are looking at unsorted nodes")).toBe(true);
    expect(parsed.body).toContain("{{nodes_dump}}");
  });

  it("reads the SKILL.md contract keys: name, description, scopes, tools, model", () => {
    const parsed = parseSkillBody(`---
name: weekly_review
description: "Produce a 200-word recap"
model: anthropic/claude-sonnet-4.5
scopes: [nodes:read, "nodes:write"]
tools:
  - name: nodes
    op: list
  - name: nodes_write
    op: create
    when: the recap is approved
---
Body.
`);
    expect(parsed.frontmatter.name).toBe("weekly_review");
    expect(parsed.frontmatter.description).toBe("Produce a 200-word recap");
    expect(parsed.frontmatter.model).toBe("anthropic/claude-sonnet-4.5");
    expect(parsed.frontmatter.scopes).toEqual(["nodes:read", "nodes:write"]);
    expect(parsed.frontmatter.tools).toEqual([
      { name: "nodes", op: "list" },
      { name: "nodes_write", op: "create", when: "the recap is approved" },
    ]);
    expect(parsed.frontmatter.fields).toEqual([]);
    expect(parsed.body).toBe("Body.\n");
  });

  it("types numbers and booleans in defaults, and treats unknown types as string", () => {
    const parsed = parseSkillBody(`---
input_schema:
  fields:
    - name: limit
      type: number
      default: 10
    - name: dry_run
      type: boolean
      required: true
      default: false
    - name: odd
      type: date
---
`);
    expect(parsed.frontmatter.fields).toEqual([
      { name: "limit", type: "number", required: false, default: 10 },
      { name: "dry_run", type: "boolean", required: true, default: false },
      { name: "odd", type: "string", required: false },
    ]);
  });

  it("is the whole body when there is no frontmatter", () => {
    const parsed = parseSkillBody("Just a prompt with {{x}}.");
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.frontmatter).toEqual({ fields: [] });
    expect(parsed.body).toBe("Just a prompt with {{x}}.");
    expect(splitFrontmatter("---\nunclosed").yaml).toBeNull();
  });

  it("falls back to the raw text when the frontmatter cannot be read", () => {
    const raw = "---\ninput_schema:\n  fields:\n      - name: a\n   bad: indentation\n---\nbody";
    const parsed = parseSkillBody(raw);
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe(raw);
  });

  it("ignores a status-like scalar it does not know and keeps the rest", () => {
    const parsed = parseSkillBody("---\ntitle: X\nextra: 3\n---\nb");
    expect(parsed.frontmatter.title).toBe("X");
    expect(parsed.body).toBe("b");
  });
});
