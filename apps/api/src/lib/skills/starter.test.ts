import { describe, expect, it } from "vitest";
import { STARTER_SKILLS, TRIAGE_INBOX } from "@bcontext-dev/contract/skills/starter";
import { parseSkillBody, validateInput, renderTemplate } from "./run";

describe("starter skills — frontmatter contract", () => {
  it("ships three canonical starters", () => {
    const keys = STARTER_SKILLS.map((s) => s.key).sort();
    expect(keys).toEqual([
      "skill-extract-decisions",
      "skill-triage-inbox",
      "skill-weekly-review",
    ]);
  });

  it("each body parses with frontmatter + input_schema.fields", () => {
    for (const s of STARTER_SKILLS) {
      const { frontmatter, body } = parseSkillBody(s.body);
      expect(frontmatter.title).toBeTruthy();
      expect(frontmatter.input_schema?.fields).toBeDefined();
      expect((frontmatter.input_schema?.fields ?? []).length).toBeGreaterThan(0);
      expect(body.length).toBeGreaterThan(0);
    }
  });

  it("validators reject missing required inputs", () => {
    for (const s of STARTER_SKILLS) {
      const { frontmatter } = parseSkillBody(s.body);
      const requiredField = frontmatter.input_schema?.fields.find((f) => f.required);
      if (!requiredField) continue;
      expect(() => validateInput(frontmatter, {})).toThrow();
    }
  });

  it("renderer applies the required var without throwing", () => {
    for (const s of STARTER_SKILLS) {
      const { frontmatter, body } = parseSkillBody(s.body);
      const requiredField = frontmatter.input_schema?.fields.find((f) => f.required);
      const input = requiredField ? { [requiredField.name]: "EXAMPLE" } : {};
      const validated = validateInput(frontmatter, input);
      const rendered = renderTemplate(body, validated);
      if (requiredField) {
        expect(rendered).toContain("EXAMPLE");
      }
    }
  });

  it("teaches kind plus reusable tags instead of duplicating category", () => {
    const { frontmatter, body } = parseSkillBody(TRIAGE_INBOX.body);
    expect(frontmatter.input_schema?.fields.map((field) => field.name)).toContain(
      "available_tags",
    );
    expect(body).toContain('"tags": ["..."]');
    expect(body).not.toContain('"category"');
    expect(TRIAGE_INBOX.body).not.toMatch(/\bfolder\b/i);
    expect(body).toContain("Decisions, meetings, tasks and bugs are kinds");
  });
});
