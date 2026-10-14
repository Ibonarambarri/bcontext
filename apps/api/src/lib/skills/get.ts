/**
 * Skill handed to the client for execution.
 *
 * `skills_run` executes a skill on the server with the server's model — right
 * for webhooks and crons, wrong for an agent that is already reasoning with
 * its own model and context. `resolveSkillForClient` is the other half: it
 * returns the skill as instructions (frontmatter, the prompt rendered with the
 * validated inputs, the declared scopes and tools) and lets the caller run
 * it. The server's job is to validate, not to execute.
 */
import { isScope, hasScope, type Scope } from "@bcontext-dev/contract/auth/scopes";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import {
  SkillError,
  parseSkillBody,
  renderTemplate,
  validateInput,
  type SkillFrontmatter,
  type SkillToolRef,
} from "./template";
import { skillVersion } from "./version";

export interface ClientSkill {
  skill_id: string;
  name: string;
  description: string;
  version: number;
  /** The frontmatter as written, minus the prompt body. */
  frontmatter: SkillFrontmatter;
  /** Optional system prompt from the frontmatter. */
  system: string | null;
  /** Body rendered with the validated inputs — what the agent executes. */
  prompt: string;
  input_validated: Record<string, unknown>;
  /** Scopes the skill declared; every one is held by the caller. */
  scopes: Scope[];
  /** Tools of this MCP the skill uses, in declared order. */
  tools: SkillToolRef[];
  /** Declared tool names that are not tools of this MCP. */
  unknown_tools?: string[];
}

/**
 * Validates the input, checks the caller holds the declared scopes (403
 * otherwise) and returns the rendered skill; tool names not in `knownTools`
 * are reported, not refused, so a skill written for a newer server degrades.
 */
export function resolveSkillForClient(
  node: KnowledgeNode,
  input: Record<string, unknown>,
  heldScopes: readonly string[],
  knownTools: ReadonlySet<string>,
): ClientSkill {
  if (node.kind !== "skill") {
    throw new SkillError(`node is not a skill (kind=${node.kind})`, 400);
  }
  const { frontmatter, body } = parseSkillBody(node.content_md ?? "");

  const scopes = normalizeScopes(frontmatter.scopes);
  const missing = scopes.filter((scope) => !hasScope(heldScopes, scope));
  if (missing.length > 0) {
    throw new SkillError(
      `skill requires scope${missing.length > 1 ? "s" : ""} you do not hold: ${missing.join(", ")}`,
      403,
    );
  }

  const tools = normalizeTools(frontmatter.tools);
  const unknown = tools.map((t) => t.name).filter((name) => !knownTools.has(name));

  const validated = validateInput(frontmatter, input);
  const prompt = renderTemplate(body, validated);

  return {
    skill_id: node.id,
    name: frontmatter.name?.trim() || node.title,
    description: frontmatter.description?.trim() || node.title,
    version: skillVersion(node.data),
    frontmatter,
    system: frontmatter.system ?? null,
    prompt,
    input_validated: validated,
    scopes,
    tools,
    ...(unknown.length > 0 ? { unknown_tools: Array.from(new Set(unknown)) } : {}),
  };
}

function normalizeScopes(raw: unknown): Scope[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new SkillError("frontmatter `scopes` must be a list");
  const out: Scope[] = [];
  for (const value of raw) {
    if (!isScope(value)) throw new SkillError(`frontmatter declares unknown scope: ${String(value)}`);
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function normalizeTools(raw: unknown): SkillToolRef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new SkillError("frontmatter `tools` must be a list");
  return raw.map((entry, i) => {
    // `tools: [nodes, nodes_write]` is the short form; objects add op/when.
    if (typeof entry === "string") return { name: entry.trim() };
    if (entry && typeof entry === "object" && typeof (entry as SkillToolRef).name === "string") {
      const t = entry as SkillToolRef;
      return {
        name: t.name.trim(),
        ...(typeof t.op === "string" ? { op: t.op } : {}),
        ...(typeof t.when === "string" ? { when: t.when } : {}),
      };
    }
    throw new SkillError(`frontmatter tools[${i}] must be a tool name or { name, op?, when? }`);
  });
}
