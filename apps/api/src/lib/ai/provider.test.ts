import { describe, expect, it } from "vitest";
import { aiBackend, aiConfigured, AiNotConfiguredError, embeddingModel, languageModel, rerankSupported } from "./provider";

const OLLAMA = { OPENAI_BASE_URL: "http://localhost:11434/v1/", OPENAI_API_KEY: "ollama" };
const GATEWAY = { AI_GATEWAY_API_KEY: "gw-key" };

describe("aiBackend", () => {
  it("is null with neither backend, and blank values do not count", () => {
    expect(aiBackend({})).toBeNull();
    expect(aiBackend({ OPENAI_BASE_URL: "  ", AI_GATEWAY_API_KEY: "" })).toBeNull();
    expect(aiConfigured({})).toBe(false);
  });

  it("picks the gateway from its key", () => {
    expect(aiBackend(GATEWAY)).toBe("gateway");
    expect(aiConfigured(GATEWAY)).toBe(true);
  });

  it("prefers an OpenAI-compatible server when both are set", () => {
    expect(aiBackend(OLLAMA)).toBe("openai-compatible");
    expect(aiBackend({ ...GATEWAY, ...OLLAMA })).toBe("openai-compatible");
  });

  it("offers rerank only on the gateway", () => {
    expect(rerankSupported(GATEWAY)).toBe(true);
    expect(rerankSupported({ ...GATEWAY, ...OLLAMA })).toBe(false);
    expect(rerankSupported({})).toBe(false);
  });
});

describe("languageModel / embeddingModel", () => {
  it("keeps plain ids on the gateway (the SDK's default provider)", () => {
    expect(languageModel("anthropic/claude-sonnet-5", GATEWAY)).toBe("anthropic/claude-sonnet-5");
    expect(embeddingModel("openai/text-embedding-3-small", GATEWAY)).toBe("openai/text-embedding-3-small");
  });

  it("builds models against the OpenAI-compatible base URL with the configured names", () => {
    const chat = languageModel("llama3.1", OLLAMA);
    expect(typeof chat).toBe("object");
    expect(chat).toMatchObject({ modelId: "llama3.1" });
    expect((chat as { provider: string }).provider).toMatch(/^openai-compatible/);
    const emb = embeddingModel("nomic-embed-text", OLLAMA);
    expect(emb).toMatchObject({ modelId: "nomic-embed-text" });
  });

  it("throws when no backend is configured", () => {
    expect(() => languageModel("x", {})).toThrow(AiNotConfiguredError);
    expect(() => embeddingModel("x", {})).toThrow(AiNotConfiguredError);
  });
});
