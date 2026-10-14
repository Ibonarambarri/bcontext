/**
 * Which model a Nexo thinks with, and who pays for it.
 *
 * Callers: the headless runner (`./runner`) and the specialist chat turn
 * (`@/lib/nexo/assistant/turn`). Both pass the result straight to the AI SDK
 * (`model` + `providerOptions`) and hand `byok` to the usage ledger.
 *
 * Order of preference:
 *   1. the organization's own AI Gateway key — the call runs on their gateway
 *      account, every model id works;
 *   2. the organization's provider key (Anthropic or OpenAI) matching the
 *      model's provider — the call goes through our gateway with the key in
 *      `providerOptions.gateway.byok`, so the provider bills them;
 *   3. the instance's own backend: an OpenAI-compatible server
 *      (`OPENAI_BASE_URL`) or our metered gateway access (`AI_GATEWAY_API_KEY`),
 *      see `@/lib/ai/provider`.
 * Null when none of them is available: the caller degrades instead of failing.
 *
 * Must not break: a BYOK lookup failure never blocks a run — it falls through
 * to metered access, which is what the org had before adding a key. Keys are
 * read per call (never cached) so a rotated or deleted key takes effect now.
 */
import { createGateway, type LanguageModel } from "ai";
import { log } from "@bcontext-dev/contract/log";
import type { Nexo, OrgAiKeyProvider } from "@bcontext-dev/contract/nexos";
import { chatModel } from "@/lib/ai/models";
import { aiBackend, languageModel } from "@/lib/ai/provider";
import { resolveOrgAiKey } from "@/lib/nexos/org-ai-keys";

export interface ResolvedNexoModel {
  model: LanguageModel;
  /** Gateway model id (`anthropic/claude-sonnet-5`), for telemetry and pricing. */
  modelId: string;
  providerOptions?: { gateway: { byok: Record<string, Array<{ apiKey: string }>> } };
  /** Whose key pays: null = our metered access. */
  byok: OrgAiKeyProvider | null;
}

/** The provider an org key must belong to for this model id, if it is one we accept keys for. */
function providerFor(modelId: string): OrgAiKeyProvider | null {
  if (modelId.startsWith("anthropic/")) return "anthropic";
  if (modelId.startsWith("openai/")) return "openai";
  return null;
}

async function orgKey(orgId: string, provider: OrgAiKeyProvider) {
  try {
    return await resolveOrgAiKey(orgId, provider);
  } catch (err) {
    log.warn("nexos.model.byok_lookup_failed", {
      organization_id: orgId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function resolveNexoModel(args: {
  organizationId: string | null;
  nexo?: Pick<Nexo, "model"> | null;
}): Promise<ResolvedNexoModel | null> {
  const modelId = chatModel(args.nexo?.model);
  const metered = process.env.AI_GATEWAY_API_KEY?.trim() || null;

  if (args.organizationId) {
    const gateway = await orgKey(args.organizationId, "gateway");
    if (gateway) {
      return { model: createGateway({ apiKey: gateway.apiKey })(modelId), modelId, byok: "gateway" };
    }
    const provider = providerFor(modelId);
    // A provider key still travels through a gateway; without ours there is
    // nothing to carry it, so it falls through to "no model" below.
    const direct = provider && metered ? await orgKey(args.organizationId, provider) : null;
    if (direct && metered) {
      return {
        model: createGateway({ apiKey: metered })(modelId),
        modelId,
        providerOptions: { gateway: { byok: { [direct.provider]: [{ apiKey: direct.apiKey }] } } },
        byok: direct.provider,
      };
    }
  }

  if (aiBackend() === "openai-compatible") return { model: languageModel(modelId), modelId, byok: null };
  if (!metered) return null;
  return { model: createGateway({ apiKey: metered })(modelId), modelId, byok: null };
}
