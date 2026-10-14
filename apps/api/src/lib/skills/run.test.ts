import { describe, expect, it } from "vitest";
import {
  SkillError,
  parseSkillBody,
  renderTemplate,
  validateInput,
} from "./run";

describe("parseSkillBody", () => {
  it("splits frontmatter from body", () => {
    const raw = `---
title: Test
model: anthropic/claude-haiku-4-5-20251001
input_schema:
  fields:
    - name: subject
      type: string
      required: true
---

Hello {{subject}}.`;
    const out = parseSkillBody(raw);
    expect(out.frontmatter.title).toBe("Test");
    expect(out.frontmatter.model).toContain("claude-haiku");
    expect(out.body.trim()).toBe("Hello {{subject}}.");
  });

  it("survives missing frontmatter", () => {
    const out = parseSkillBody("Hi {{x}}!");
    expect(out.frontmatter).toEqual({});
    expect(out.body).toBe("Hi {{x}}!");
  });
});

describe("validateInput", () => {
  const fm = {
    input_schema: {
      fields: [
        { name: "name", type: "string" as const, required: true },
        { name: "count", type: "number" as const, default: 3 },
      ],
    },
  };

  it("accepts a valid input", () => {
    expect(validateInput(fm, { name: "ada", count: 5 })).toEqual({
      name: "ada",
      count: 5,
    });
  });

  it("applies defaults", () => {
    expect(validateInput(fm, { name: "ada" })).toEqual({
      name: "ada",
      count: 3,
    });
  });

  it("rejects missing required", () => {
    expect(() => validateInput(fm, {})).toThrow(SkillError);
  });

  it("rejects wrong type", () => {
    expect(() => validateInput(fm, { name: 42 })).toThrow(/must be string/);
  });

  it("returns {} for empty schema", () => {
    expect(validateInput({}, { spurious: 1 })).toEqual({});
  });
});

describe("renderTemplate", () => {
  it("substitutes {{var}}", () => {
    expect(renderTemplate("Hi {{name}}!", { name: "Ada" })).toBe("Hi Ada!");
  });

  it("collapses missing vars to empty string", () => {
    expect(renderTemplate("Hi {{name}}!", {})).toBe("Hi !");
  });

  it("tolerates spaces inside braces", () => {
    expect(renderTemplate("{{  x  }}", { x: "ok" })).toBe("ok");
  });

  it("preserves non-matching content", () => {
    expect(renderTemplate("`{{ }}` keep", {})).toBe("`{{ }}` keep");
  });
});
