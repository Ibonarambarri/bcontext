/**
 * Skill execution engine.
 *
 * A `skill` node is a typed prompt template. Frontmatter declares an
 * input schema (Zod-flavoured JSON Schema) and an output shape. The body
 * is a Mustache-ish template — `{{var}}` references resolve against the
 * validated input.
 *
 * Execution:
 *   1. Load the skill node by id.
 *   2. Parse the body's frontmatter (input schema, model override).
 *   3. Validate `input` against the schema → 400 on shape mismatch.
 *   4. Render the prompt by interpolating `{{var}}`.
 *   5. Call the AI Gateway with the rendered prompt; stream-buffer the
 *      response.
 *   6. Return { rendered_prompt, output, model_used, tokens }.
 *
 * Pure-completion only — tool calls during skill execution are
 * intentionally not supported in v1 (keeps the surface small + safe).
 * That design choice is the reason `skills_run` is a different MCP tool
 * from a generic chat call.
 */
import { createGateway, generateText } from "ai";
import {
  SkillError,
  parseSkillBody,
  renderTemplate,
  validateInput,
} from "./template";
import { chatModel } from "@/lib/ai/models";
import { aiConfigured, languageModel } from "@/lib/ai/provider";
import type { Storage } from "@/lib/storage";
import { recordAiUsageEvent, tokensFromUsage } from "@/lib/telemetry/ai-usage";

export interface RunSkillInput {
  skill_id: string;
  input: Record<string, unknown>;
  /** Optional override; falls back to skill frontmatter then env. */
  model?: string;
}

export interface RunSkillOutput {
  skill_id: string;
  rendered_prompt: string;
  output: string;
  model_used: string;
  input_validated: Record<string, unknown>;
}

export {
  SkillError,
  parseSkillBody,
  renderTemplate,
  validateInput,
  type SkillFrontmatter,
  type SkillToolRef,
} from "./template";

/**
 * Server-side execution (`skills_run`, REST, schedules): steps 1–6 above.
 * `apiKey` overrides the gateway key and `subjectUserId` attributes the AI
 * usage row; both default to the process configuration.
 */
export async function runSkill(
  storage: Storage,
  input: RunSkillInput,
  apiKey?: string,
  subjectUserId?: string | null,
): Promise<RunSkillOutput> {
  const node = await storage.getNode(input.skill_id);
  if (!node) throw new SkillError(`skill not found: ${input.skill_id}`, 404);
  if (node.kind !== "skill") {
    throw new SkillError(`node is not a skill (kind=${node.kind})`, 400);
  }

  const parsed = parseSkillBody(node.content_md ?? "");
  const validated = validateInput(parsed.frontmatter, input.input);
  const rendered = renderTemplate(parsed.body, validated);

  const model = chatModel(input.model ?? parsed.frontmatter.model);

  // A key passed in is the caller's own gateway account; otherwise the
  // instance's backend (`@/lib/ai/provider`).
  if (!apiKey && !aiConfigured()) {
    throw new SkillError("no AI backend configured (AI_GATEWAY_API_KEY or OPENAI_BASE_URL) — skill execution disabled", 503);
  }
  const system =
    parsed.frontmatter.system ??
    "You are a skill executor. Respond exactly as the prompt instructs. No preamble.";

  const result = await generateText({
    model: apiKey ? createGateway({ apiKey })(model) : languageModel(model),
    system,
    prompt: rendered,
  });

  if (storage.backend === "supabase") {
    void recordAiUsageEvent({
      workspaceId: storage.workspace.id,
      subjectUserId,
      surface: "skill_run",
      model,
      tokens: tokensFromUsage(result.usage),
      metadata: { skill_id: input.skill_id },
    });
  }

  return {
    skill_id: input.skill_id,
    rendered_prompt: rendered,
    output: result.text,
    model_used: model,
    input_validated: validated,
  };
}
