import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chatModel,
  contextModel,
  DEFAULT_CHAT_MODEL,
  DEFAULT_CONTEXT_MODEL,
  DEFAULT_EXTRACT_MODEL,
  DEFAULT_EXTRACT_PROVIDERS,
  extractModel,
  extractProviderOptions,
} from "./models";

const NAMES = ["CHAT_MODEL", "CONTEXT_MODEL", "EXTRACT_MODEL", "EXTRACT_PROVIDERS", "AI_GATEWAY_API_KEY", "OPENAI_BASE_URL"] as const;
const saved: Partial<Record<(typeof NAMES)[number], string | undefined>> = {};

beforeEach(() => {
  for (const n of NAMES) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe("model resolution", () => {
  it("each surface has its own default and CHAT_MODEL reaches only the chat surfaces", () => {
    process.env.CHAT_MODEL = "anthropic/claude-sonnet-5";
    expect(chatModel()).toBe("anthropic/claude-sonnet-5");
    expect(contextModel()).toBe(DEFAULT_CONTEXT_MODEL);
    expect(extractModel()).toBe(DEFAULT_EXTRACT_MODEL);
  });

  it("CONTEXT_MODEL and EXTRACT_MODEL pin their own loops", () => {
    process.env.CONTEXT_MODEL = "openai/gpt-5-nano";
    process.env.EXTRACT_MODEL = "openai/gpt-5-mini";
    expect(contextModel()).toBe("openai/gpt-5-nano");
    expect(extractModel()).toBe("openai/gpt-5-mini");
    expect(chatModel()).toBe(DEFAULT_CHAT_MODEL);
  });

  it("keeps each surface's precedence: env wins for context, the caller wins for chat and extract", () => {
    process.env.CHAT_MODEL = "a/chat";
    process.env.CONTEXT_MODEL = "a/context";
    process.env.EXTRACT_MODEL = "a/extract";
    expect(chatModel("b/override")).toBe("b/override");
    expect(extractModel("b/override")).toBe("b/override");
    expect(contextModel("b/override")).toBe("a/context");
  });

  it("treats blank values as unset", () => {
    process.env.CONTEXT_MODEL = "  ";
    expect(contextModel(" ")).toBe(DEFAULT_CONTEXT_MODEL);
    expect(chatModel("")).toBe(DEFAULT_CHAT_MODEL);
  });

});

describe("extractProviderOptions", () => {
  beforeEach(() => {
    process.env.AI_GATEWAY_API_KEY = "gw-key";
  });

  it("is a gateway option: nothing off the gateway", () => {
    process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
    expect(extractProviderOptions("deepseek/deepseek-v4-flash")).toBeUndefined();
  });

  it("pins the serving hosts and opts out of training for open-weight models", () => {
    expect(extractProviderOptions("deepseek/deepseek-v4-flash")).toEqual({
      gateway: { only: DEFAULT_EXTRACT_PROVIDERS, disallowPromptTraining: true },
    });
    expect(extractProviderOptions("moonshotai/kimi-k2.5")?.gateway.only).toEqual(DEFAULT_EXTRACT_PROVIDERS);
  });

  it("leaves first-party models to the gateway's own routing", () => {
    expect(extractProviderOptions("google/gemini-3-flash")).toBeUndefined();
    expect(extractProviderOptions("anthropic/claude-sonnet-5")).toBeUndefined();
    expect(extractProviderOptions("openai/gpt-5-mini")).toBeUndefined();
  });

  it("EXTRACT_PROVIDERS overrides the host list", () => {
    process.env.EXTRACT_PROVIDERS = "azure, fireworks";
    expect(extractProviderOptions("deepseek/deepseek-v4-flash")?.gateway.only).toEqual(["azure", "fireworks"]);
  });

  it("follows the resolved extract model when none is given", () => {
    process.env.EXTRACT_MODEL = "google/gemini-3-flash";
    expect(extractProviderOptions()).toBeUndefined();
    delete process.env.EXTRACT_MODEL;
    expect(extractProviderOptions()?.gateway.only).toEqual(DEFAULT_EXTRACT_PROVIDERS);
  });
});
