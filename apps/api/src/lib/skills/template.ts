/**
 * Skill template contract: frontmatter shape, input validation and `{{var}}`
 * rendering. Pure — no model, no storage — so both execution paths share it:
 * `run.ts` (server-side, `skills_run`) and `get.ts` (handed to the client,
 * `skills(op=get)`).
 */
import matter from "gray-matter";

export class SkillError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** One MCP tool a skill declares it uses, in execution order. */
export interface SkillToolRef {
  /** Native tool of this MCP (`nodes`, `nodes_write`, ...). */
  name: string;
  /** Operation within the tool (`get`, `create`, ...). */
  op?: string;
  /** Free-text condition for when the step applies. */
  when?: string;
}

export interface SkillFrontmatter {
  /** Skill name (SKILL.md contract); what `skills(op=list)` shows. */
  name?: string;
  /** One-line description (SKILL.md contract). */
  description?: string;
  /** Optional title override (display only). */
  title?: string;
  /**
   * Scopes the executing agent must hold. `skills(op=get)` refuses
   * to hand the skill over when the caller is missing one.
   */
  scopes?: string[];
  /** Tools of this MCP the skill uses, in order. */
  tools?: SkillToolRef[];
  /** Per-skill model pin; falls back to caller / env / DEFAULT. */
  model?: string;
  /** Zod-flavoured input schema: { fields: [{ name, type, required }, ...] }. */
  input_schema?: {
    fields: Array<{
      name: string;
      type: "string" | "number" | "boolean";
      required?: boolean;
      default?: unknown;
      description?: string;
    }>;
  };
  /** Optional system prompt prepended to the rendered body. */
  system?: string;
}

/** Frontmatter + body of a skill node; unparseable frontmatter yields `{}` and the raw body. */
export function parseSkillBody(raw: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  try {
    const parsed = matter(raw);
    return {
      frontmatter: (parsed.data ?? {}) as SkillFrontmatter,
      body: parsed.content.replace(/^\n+/, ""),
    };
  } catch {
    return { frontmatter: {}, body: raw };
  }
}

/**
 * Coerces nothing: each declared field must arrive with its declared type,
 * required ones must be present, defaults fill absent optionals. Undeclared
 * keys are dropped so the template never sees unexpected variables.
 */
export function validateInput(
  fm: SkillFrontmatter,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const fields = fm.input_schema?.fields ?? [];
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = input[field.name];
    if (value === undefined || value === null) {
      if (field.required) {
        throw new SkillError(`missing required input: ${field.name}`);
      }
      if (field.default !== undefined) out[field.name] = field.default;
      continue;
    }
    const typeOk =
      (field.type === "string" && typeof value === "string") ||
      (field.type === "number" && typeof value === "number") ||
      (field.type === "boolean" && typeof value === "boolean");
    if (!typeOk) {
      throw new SkillError(
        `input "${field.name}" must be ${field.type}, got ${typeof value}`,
      );
    }
    out[field.name] = value;
  }
  return out;
}

/** `{{var}}` substitution only — no logic, no escaping; missing vars render empty. */
export function renderTemplate(
  template: string,
  vars: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}
