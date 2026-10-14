/**
 * Without a model the prompt is the contract's deterministic template — the
 * same text the wizard previews — and it always carries the six sections.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasNexoPromptSections, renderNexoPrompt, NEXO_PROMPT_SECTIONS } from "@bcontext-dev/contract/nexos";

const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText,
}));

import { generateNexoPrompt } from "./prompt";

const questionnaire = {
  name: "Soporte",
  mission: "Atender a clientes por Slack.",
  sources: ["slack"],
  can_do_alone: ["read" as const, "draft_replies" as const],
  escalate_when: "un cliente se queja de facturación",
  tone: "cercano" as const,
  language: "es",
  routine: "Revisar hilos sin respuesta.",
};

afterEach(() => {
  vi.unstubAllEnvs();
  generateText.mockReset();
});

describe("generateNexoPrompt", () => {
  it("falls back to the template without a gateway key", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const out = await generateNexoPrompt({ questionnaire });
    expect(out.source).toBe("template");
    expect(out.prompt_md).toBe(renderNexoPrompt(questionnaire));
    expect(hasNexoPromptSections(out.prompt_md)).toBe(true);
    expect(out.prompt_md).toContain("un cliente se queja de facturación");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("uses the model when its answer has every section, unfenced", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
    const md = NEXO_PROMPT_SECTIONS.map((s) => `## ${s}\n\ntexto`).join("\n\n");
    generateText.mockResolvedValue({ text: "```markdown\n" + md + "\n```", usage: {} });
    const out = await generateNexoPrompt({ questionnaire });
    expect(out).toMatchObject({ source: "model", prompt_md: md });
  });

  it("names the language for the model, not its code", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
    const md = NEXO_PROMPT_SECTIONS.map((s) => `## ${s}\n\ntexto`).join("\n\n");
    generateText.mockResolvedValue({ text: md, usage: {} });
    await generateNexoPrompt({ questionnaire: { ...questionnaire, language: "en" } });
    const call = JSON.stringify(generateText.mock.calls[0]);
    expect(call).toContain("Idioma: English");
    expect(call).not.toContain("Idioma: en\\n");
  });

  it("falls back when the model drops a section or fails", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
    generateText.mockResolvedValueOnce({ text: "## Identidad\n\nSolo esto", usage: {} });
    expect((await generateNexoPrompt({ questionnaire })).source).toBe("template");
    generateText.mockRejectedValueOnce(new Error("gateway down"));
    expect((await generateNexoPrompt({ questionnaire })).source).toBe("template");
  });
});
