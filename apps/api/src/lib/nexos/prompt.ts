/**
 * Questionnaire → `prompt_md`, the instructions a Nexo runs with.
 *
 * With a model available (`@/lib/ai/provider`) the chat model writes the
 * prompt from the answers, which reads far better than a fill-in-the-blanks
 * template. Without one — demo backend, tests, a gateway outage — and
 * whenever the model's answer lacks any of the six fixed sections, the
 * deterministic `renderNexoPrompt` from the contract is used instead: the
 * same thing the creation wizard previews, so the result is never worse than
 * what the person already saw.
 *
 * Callers: `POST /api/nexos` (create and preview) and
 * `POST /api/nexos/:id/prompt` (regenerate). Must not break: the output
 * always carries every `NEXO_PROMPT_SECTIONS` heading, in order — the editor
 * and the runtime both rely on them.
 */
import { generateText } from "ai";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { log } from "@bcontext-dev/contract/log";
import {
  NEXO_CAN_DO_LABEL,
  NEXO_LIMITS,
  NEXO_PROMPT_SECTIONS,
  NEXO_TONE_LABEL,
  hasNexoPromptSections,
  nexoLanguageName,
  renderNexoPrompt,
  type NexoQuestionnaire,
} from "@bcontext-dev/contract/nexos";
import { chatModel } from "@/lib/ai/models";
import { aiConfigured, languageModel } from "@/lib/ai/provider";
import { recordAiUsageEvent, tokensFromUsage } from "@/lib/telemetry/ai-usage";

export interface GeneratedNexoPrompt {
  prompt_md: string;
  source: "model" | "template";
  model: string | null;
}

export interface GenerateNexoPromptInput {
  questionnaire: NexoQuestionnaire;
  /** Template key, as context for the model ("support", "custom"…). */
  template?: string;
  workspaceName?: string;
  /** For the AI usage ledger; no ledger row without it. */
  workspaceId?: string;
  subjectUserId?: string | null;
}

const SYSTEM = `Escribes las instrucciones de un asistente de IA que trabaja dentro de Bcontext, el cerebro compartido de una empresa.
Devuelve SOLO Markdown, sin preámbulo ni bloque de código, con EXACTAMENTE estas secciones H2, en este orden:
${NEXO_PROMPT_SECTIONS.map((s) => `## ${s}`).join("\n")}
Reglas:
- "Identidad" empieza por "Eres <Nombre>", con el nombre exacto de las respuestas. "Nexo" es el nombre del producto de agentes, no el del asistente: no lo llames así salvo que ese sea su nombre.
- Segunda persona ("Eres…", "Avisa cuando…"), frases cortas y concretas.
- No inventes capacidades, integraciones ni datos que no estén en las respuestas.
- "Qué puede hacer sin preguntar" es una lista; lo que no aparezca ahí requiere confirmación.
- "Cuándo avisar" debe dejar claro que ante la duda escala a una persona en lugar de inventar.
- Escribe en el idioma indicado en las respuestas.`;

function describe(q: NexoQuestionnaire, template?: string, workspaceName?: string): string {
  return [
    workspaceName ? `Empresa / workspace: ${workspaceName}` : null,
    template ? `Plantilla: ${template}` : null,
    `Nombre: ${q.name}`,
    `De qué se encarga: ${q.mission}`,
    `Integraciones que escucha: ${q.sources.length ? q.sources.join(", ") : "ninguna todavía"}`,
    `Puede hacer sin preguntar: ${q.can_do_alone.map((c) => NEXO_CAN_DO_LABEL[c].es).join(", ") || "nada"}`,
    `Cuándo avisar: ${q.escalate_when || "(sin especificar)"}`,
    `Tono: ${NEXO_TONE_LABEL[q.tone].es}`,
    `Idioma: ${nexoLanguageName(q.language)}`,
    `Rutina en cada latido: ${q.routine || "(sin rutina)"}`,
  ].filter(Boolean).join("\n");
}

/** Strip a wrapping ```markdown fence some models add despite being told not to. */
function unfence(text: string): string {
  const t = text.trim();
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(t);
  return (m ? m[1]! : t).trim();
}

/** Generate a prompt; never throws — the template is always the floor. */
export async function generateNexoPrompt(input: GenerateNexoPromptInput): Promise<GeneratedNexoPrompt> {
  const fallback: GeneratedNexoPrompt = {
    prompt_md: renderNexoPrompt(input.questionnaire),
    source: "template",
    model: null,
  };
  // Read at call time (like `@/lib/rag`), so a key rotated into the process
  // environment — or stubbed by a test — is seen without a restart.
  if (!aiConfigured()) return fallback;

  const model = chatModel();
  try {
    const result = await generateText({
      model: languageModel(model),
      system: SYSTEM,
      prompt: describe(input.questionnaire, input.template, input.workspaceName),
      maxOutputTokens: 1500,
    });
    if (input.workspaceId && isSupabaseConfigured()) {
      void recordAiUsageEvent({
        workspaceId: input.workspaceId,
        subjectUserId: input.subjectUserId ?? null,
        surface: "nexo",
        model,
        tokens: tokensFromUsage(result.usage),
        providerMetadata: result.providerMetadata as Record<string, Record<string, unknown>> | undefined,
        // No `nexo_id`: writing a Nexo's prompt is setup, not the Nexo's own
        // work, and must not eat into its monthly budget.
        metadata: { op: "nexo_prompt" },
      });
    }
    const text = unfence(result.text ?? "");
    if (!text || text.length > NEXO_LIMITS.prompt || !hasNexoPromptSections(text)) {
      log.warn("nexos.prompt.unusable_model_output", { model, length: text.length });
      return fallback;
    }
    return { prompt_md: text, source: "model", model };
  } catch (err) {
    log.warn("nexos.prompt.model_error", { model, error: err instanceof Error ? err.message : String(err) });
    return fallback;
  }
}
