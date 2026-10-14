/**
 * Where the instance's model calls go.
 *
 * Two backends, picked by env at call time:
 *
 *   openai-compatible  `OPENAI_BASE_URL` (+ `OPENAI_API_KEY` when the server
 *                      wants one): any server that speaks the OpenAI chat and
 *                      embeddings API — Ollama, LiteLLM, vLLM, OpenAI itself.
 *                      Wins when set: it is an explicit self-hosting choice.
 *   gateway            `AI_GATEWAY_API_KEY`: Vercel AI Gateway, "provider/model"
 *                      ids, the only backend with rerank.
 *
 * Neither set → `aiBackend()` is null and every caller degrades the way it
 * already did without a gateway key (retrieval-only answers, keyword search,
 * skipped embeds). Model ids come from the same variables either way
 * (`CHAT_MODEL`, `CONTEXT_MODEL`, `EXTRACT_MODEL`, `EMBEDDING_MODEL` —
 * `src/lib/ai/models.ts`, `src/lib/rag.ts`); against an OpenAI-compatible
 * server they must be that server's names (`llama3.1`, `nomic-embed-text`).
 *
 * Callers resolve the instance's own models here. A key someone brings for
 * one call (an organization's BYOK gateway key, a per-request header) still
 * builds its own `createGateway` at the call site: that is their account,
 * not the instance's.
 *
 * pgvector columns are `vector(1536)`: whatever `EMBEDDING_MODEL` names must
 * return 1536-dimensional vectors, or every embed write fails.
 */
import type { EmbeddingModel, LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export type AiBackend = "openai-compatible" | "gateway";

function clean(v: string | undefined | null): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** Which backend serves the instance's models, or null when none is configured. */
export function aiBackend(env: NodeJS.ProcessEnv = process.env): AiBackend | null {
  if (clean(env.OPENAI_BASE_URL)) return "openai-compatible";
  if (clean(env.AI_GATEWAY_API_KEY)) return "gateway";
  return null;
}

/** True when some backend can serve model calls. */
export function aiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return aiBackend(env) !== null;
}

/**
 * Rerank exists only on the gateway; an OpenAI-compatible server has no
 * rerank endpoint, so search keeps its hybrid order there.
 */
export function rerankSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  return aiBackend(env) === "gateway";
}

function openAICompatible(env: NodeJS.ProcessEnv) {
  return createOpenAICompatible({
    name: "openai-compatible",
    baseURL: clean(env.OPENAI_BASE_URL)!.replace(/\/+$/, ""),
    apiKey: clean(env.OPENAI_API_KEY),
  });
}

/** Thrown when a model is asked for and no backend is configured. */
export class AiNotConfiguredError extends Error {
  constructor() {
    super("no AI backend configured (set AI_GATEWAY_API_KEY or OPENAI_BASE_URL)");
    this.name = "AiNotConfiguredError";
  }
}

/**
 * A chat/completion model by id, from the configured backend. On the gateway
 * the id stays a plain string: the SDK's default global provider IS the
 * gateway and reads `AI_GATEWAY_API_KEY` itself, which is how every call
 * resolved its model before this module existed.
 */
export function languageModel(modelId: string, env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const backend = aiBackend(env);
  if (backend === "openai-compatible") return openAICompatible(env).chatModel(modelId);
  if (backend === "gateway") return modelId;
  throw new AiNotConfiguredError();
}

/** An embedding model by id, from the configured backend (a plain id on the gateway, as above). */
export function embeddingModel(modelId: string, env: NodeJS.ProcessEnv = process.env): EmbeddingModel {
  const backend = aiBackend(env);
  if (backend === "openai-compatible") return openAICompatible(env).embeddingModel(modelId);
  if (backend === "gateway") return modelId;
  throw new AiNotConfiguredError();
}
