/**
 * One streamed turn of a conversation with a Nexo — the body of
 * `POST /api/nexo` (the general Nexo) and `POST /api/nexos/:id/chat` (any
 * Nexo; the general one behaves exactly like `/api/nexo`).
 *
 * Shape of a turn:
 *
 *   1. open the workspace with the caller's grants (writes are checked deeper,
 *      inside scoped storage, when a tool actually runs)
 *   2. meter it against the organization's `ai_queries` (and, for a
 *      specialist, its monthly budget)
 *   3. resolve (or open) the conversation this turn belongs to
 *   4. gather context: the open node, a small neighbourhood, this turn's hits
 *   5. stream the model's work back as NDJSON
 *
 * A specialist Nexo changes four things and nothing else: its `prompt_md`
 * joins the system prompt, its brain-tool switches narrow the tools, its
 * conversations carry its `nexo_id`, and its calls are recorded under
 * `metadata.nexo_id` (model and BYOK through `resolveNexoModel`). The person
 * chatting is still the principal: storage is scoped to THEIR grant, the
 * Nexo's switches only narrow it further.
 *
 * Must not break: the general path is byte-for-byte the old `/api/nexo`
 * (same headers, same metering, same model selection incl. the
 * `x-ai-gateway-key` / `x-chat-model` headers), and the wire is NDJSON from
 * `./wire` either way.
 */
import { createGateway, streamText, stepCountIs, type ModelMessage } from "ai";
import { env } from "@bcontext-dev/contract/env";
import { log } from "@bcontext-dev/contract/log";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { Nexo, NexoRunStep } from "@bcontext-dev/contract/nexos";
import { PageContextSchema } from "@bcontext-dev/contract/nexo/assistant";
import { chatModel } from "@/lib/ai/models";
import { aiConfigured, languageModel } from "@/lib/ai/provider";
import { actingUserId } from "@/lib/auth/require";
import type { WorkspaceContext } from "@/lib/auth/workspace";
import type { Storage } from "@/lib/storage";
import {
  appendMessage,
  createConversation,
  getConversationById,
  renameConversation,
  titleFromFirstMessage,
} from "@/lib/chat/conversations";
import { recordUsage } from "@/lib/organizations/meters";
import { citationsFromHits, retrieveScoped } from "@/lib/rag";
import { RetrievalScopeSchema } from "@/lib/rag/scope";
import { viewPrincipal } from "@/lib/views/access";
import { recordAiUsageEvent, tokensFromUsage } from "@/lib/telemetry/ai-usage";
import { nexoTarget, createRun, finishRun } from "@/lib/nexos/store";
import { checkNexoBudget, recordNexoUsage } from "@/lib/nexos/runtime/budget";
import { filterBrainTools } from "@/lib/nexos/runtime/brain-tools";
import { resolveNexoModel } from "@/lib/nexos/runtime/model";
import { buildNexoMessages, NEIGHBOURHOOD_MAX_NODES } from "./prompt";
import { buildNexoTools } from "./tools";
import { streamAsNdjson, textAsNdjson } from "./wire";

/** Documents pulled around the open node before the map is trimmed. */
const NEIGHBOURHOOD_FETCH = 120;

/** Steps one turn may take: read → search → read → write → summarise, with room. */
const MAX_STEPS = 14;

export interface NexoTurnBody {
  workspace: string;
  messages: { role: "user" | "assistant" | "system"; content: string }[];
  /** Where the user is standing. Optional — Nexo degrades to workspace level. */
  pageContext?: unknown;
  /** Omit to have the turn open a fresh conversation; the id comes back in a header. */
  conversationId?: string;
  scope?: unknown;
}

export interface NexoTurnOptions {
  /**
   * Opens the workspace for the caller. Called after the body validates, so a
   * malformed body is a 400 before any auth work, as it always was.
   */
  open: () => Promise<WorkspaceContext | Response>;
  /** The Nexo this turn is with, once the workspace is open. Omitted = general. */
  loadNexo?: (ctx: WorkspaceContext) => Promise<Nexo | Response>;
}

export async function nexoChatTurn(
  req: Request,
  body: NexoTurnBody,
  opts: NexoTurnOptions,
): Promise<Response> {
  const parsedScope = RetrievalScopeSchema.optional().safeParse(body.scope);
  if (!parsedScope.success) {
    return Response.json({ error: parsedScope.error.flatten() }, { status: 400 });
  }
  const parsedContext = PageContextSchema.nullish().safeParse(body.pageContext);
  if (!parsedContext.success) {
    return Response.json({ error: parsedContext.error.flatten() }, { status: 400 });
  }
  const pageContext = parsedContext.data ?? null;

  const opened = await opts.open();
  if (opened instanceof Response) return opened;
  const { storage, actor: gated } = opened;
  const userId = actingUserId(gated);

  const loaded = opts.loadNexo ? await opts.loadNexo(opened) : null;
  if (loaded instanceof Response) return loaded;
  // The general Nexo is the old assistant, unchanged; only a specialist
  // brings its own prompt, switches, history and budget.
  const specialist = loaded && !loaded.is_general ? loaded : null;
  const target = nexoTarget(storage);

  const organizationId =
    storage.backend === "supabase" ? storage.workspace.organization_id : null;
  const nexoModel = specialist
    ? await resolveNexoModel({ organizationId, nexo: specialist })
    : null;

  // Counted on the organization's `ai_queries` meter, attributed to the person.
  if (organizationId) {
    void recordUsage(organizationId, userId, "ai_queries");
  }
  if (specialist) {
    const budget = await checkNexoBudget({ target, nexo: specialist });
    if (!budget.ok && budget.reason === "nexo_budget") {
      return Response.json(
        { error: "nexo_budget_exhausted", message: budget.message, spent_usd: budget.spentUsd, limit_usd: budget.limitUsd },
        { status: 402 },
      );
    }
  }

  const conversationId = await resolveConversation(body, storage, userId, specialist?.id ?? null);

  const headerKey = req.headers.get("x-ai-gateway-key");
  const headerModel = req.headers.get("x-chat-model");
  const instanceAi = aiConfigured();
  // A specialist's model (incl. the organization's own key) comes from
  // `resolveNexoModel`; the request headers are a general-Nexo affordance.
  const hasModel = specialist ? Boolean(nexoModel) : instanceAi || Boolean(headerKey);
  const model = specialist ? (nexoModel?.modelId ?? chatModel(specialist.model)) : env.CHAT_MODEL || headerModel || chatModel();

  const openNodeId = pageContext?.open_node?.id ?? null;
  const openNode = openNodeId
    ? ((await storage.getNode(openNodeId).catch(() => null)) ?? null)
    : null;

  const neighbourhood = await gatherNeighbourhood(storage, openNode);

  const question =
    [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const principal = await viewPrincipal(gated, storage);
  const retrieval = question
    ? await retrieveScoped(body.workspace, question, {
        k: 5,
        scope: parsedScope.data,
        storage,
        viewPrincipal: principal,
      }).catch(() => null)
    : null;

  const base = buildNexoMessages({
    workspaceName: storage.workspace.name,
    nodes: neighbourhood,
    openNode,
    pageContext,
    userMessages: body.messages,
    ragContext: retrieval,
  });
  const messages = specialist ? withSpecialistPrompt(base, specialist) : base;

  const headers: Record<string, string> = {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (conversationId) headers["x-conversation-id"] = conversationId;
  if (openNode) headers["x-active-node"] = openNode.id;
  if (retrieval) {
    headers["x-rag-scope"] = retrieval.scope.type;
    headers["x-rag-scope-size"] = String(retrieval.scope.size);
    headers["x-rag-workspace-size"] = String(retrieval.scope.workspace_size);
    headers["x-citations"] = encodeURIComponent(
      JSON.stringify(citationsFromHits(retrieval.hits)),
    );
  }

  // No gateway configured (a fresh clone, or a demo): say so in the stream
  // instead of failing, so the whole surface stays walkable.
  if (!hasModel) {
    const note = noGatewayNote(neighbourhood.length, openNode);
    if (conversationId) {
      void appendMessage(conversationId, { role: "assistant", content: note }).catch(
        () => {},
      );
    }
    return new Response(textAsNdjson(note), { headers });
  }

  // A specialist's chat turns are runs too: its activity log shows them.
  const runId = specialist
    ? await createRun(target, { nexoId: specialist.id, trigger: "chat", input: { conversation_id: conversationId } })
        .then((r) => r.id)
        .catch(() => null)
    : null;
  if (runId) headers["x-nexo-run-id"] = runId;

  try {
    const allTools = buildNexoTools({
      storage,
      workspaceRef: body.workspace,
      viewPrincipal: principal,
      actorId: userId,
    });
    // When only a header key is present, build a per-request gateway so the
    // SDK doesn't fall back to a missing env var.
    const useHeaderGateway = !specialist && !instanceAi && Boolean(headerKey);
    const result = streamText({
      model: nexoModel
        ? nexoModel.model
        : useHeaderGateway
          ? createGateway({ apiKey: headerKey! })(model)
          : languageModel(model),
      ...(nexoModel?.providerOptions ? { providerOptions: nexoModel.providerOptions } : {}),
      // `messages` rather than a top-level `system` string, so the first block
      // can carry Anthropic's `cache_control` marker (see prompt.ts).
      messages,
      allowSystemInMessages: true,
      temperature: 0.3,
      tools: specialist
        ? (filterBrainTools(allTools, specialist.brain_tools, { headless: false }) as typeof allTools)
        : allTools,
      stopWhen: stepCountIs(MAX_STEPS),
      onError: () => {
        if (runId) void finishRun(target, runId, { status: "failed", error: "stream_error" }).catch(() => {});
      },
      onFinish: (event) => {
        logCacheUsage(event.providerMetadata, body.workspace);
        if (specialist && nexoModel) {
          void recordNexoUsage({
            target,
            nexoId: specialist.id,
            subjectUserId: userId,
            modelId: nexoModel.modelId,
            byok: nexoModel.byok,
            usage: event.totalUsage,
            providerMetadata: event.providerMetadata as Record<string, Record<string, unknown>> | undefined,
            metadata: { steps: event.steps.length, finish_reason: event.finishReason, trigger: "chat" },
          }).then((cost) => {
            if (!runId) return;
            return finishRun(target, runId, {
              status: "succeeded",
              output_md: (event.text ?? "").slice(0, 4_000),
              steps: stepsSummary(event.steps),
              usage: {
                model: nexoModel.modelId,
                byok: nexoModel.byok,
                input_tokens: event.totalUsage?.inputTokens ?? 0,
                output_tokens: event.totalUsage?.outputTokens ?? 0,
                cost_usd: cost,
                model_steps: event.steps.length,
              },
            });
          }).catch(() => {});
        } else if (storage.backend === "supabase") {
          // `event.usage` is the last step only. A turn runs up to
          // MAX_STEPS model calls (one per tool round-trip), each re-sending
          // the whole prompt, and `totalUsage` is their sum — the number the
          // usage ledger has to see. Recording the last step alone
          // undercounted chat by the number of tool calls in the turn.
          void recordAiUsageEvent({
            workspaceId: storage.workspace.id,
            subjectUserId: userId,
            surface: "nexo",
            model,
            tokens: tokensFromUsage(event.totalUsage),
            metadata: { steps: event.steps.length, finish_reason: event.finishReason },
          });
        }
        if (conversationId) {
          void appendMessage(conversationId, {
            role: "assistant",
            content: event.text ?? "",
            metadata: finishMetadata(event),
          }).catch(() => {});
        }
      },
    });
    return new Response(streamAsNdjson(result.fullStream), { headers });
  } catch (err) {
    if (runId) void finishRun(target, runId, { status: "failed", error: "model_error" }).catch(() => {});
    return new Response(
      `Model error: ${err instanceof Error ? err.message : String(err)}`,
      { status: 500 },
    );
  }
}

/**
 * The specialist's own instructions, right after the cached static block:
 * they are stable per Nexo, so they do not disturb the cache of what follows
 * any more than the page context does.
 */
function withSpecialistPrompt(messages: ModelMessage[], nexo: Nexo): ModelMessage[] {
  const block: ModelMessage = {
    role: "system",
    content: [
      `## You are ${nexo.name}`,
      `In this workspace you are not the general assistant but ${nexo.name}, a specialist Nexo. Follow these instructions over the general guidance above where they differ; stay within what your tools allow.`,
      "",
      nexo.prompt_md.trim(),
    ].join("\n"),
  };
  return [messages[0]!, block, ...messages.slice(1)];
}

function stepsSummary(steps: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName: string }> }>): NexoRunStep[] {
  const out: NexoRunStep[] = [];
  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      if (out.length >= 60) return out;
      out.push({ tool: call.toolName, ok: true });
    }
  }
  return out;
}

/**
 * The little map Nexo gets for free.
 *
 * With a node open it is that node's documented surroundings; without one it
 * is the most recently touched nodes, which is where a person picking the
 * workspace back up usually means. Everything else Nexo finds by searching —
 * that is the whole reason this is 60 nodes and not the workspace.
 */
async function gatherNeighbourhood(
  storage: Storage,
  openNode: KnowledgeNode | null,
): Promise<KnowledgeNode[]> {
  try {
    if (openNode) {
      const around = await storage.listNodeContext(openNode.id, NEIGHBOURHOOD_FETCH);
      return around.length ? around : [openNode];
    }
    const recent = await storage.listNodeSummaries({ limit: 200 });
    return [...recent]
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .slice(0, NEIGHBOURHOOD_MAX_NODES) as unknown as KnowledgeNode[];
  } catch {
    // A map is a convenience, never a precondition: Nexo can still search.
    return openNode ? [openNode] : [];
  }
}

/**
 * Resolve the conversation this turn belongs to, opening one when the client
 * didn't name it, and persist the inbound user message.
 *
 * Persistence is the default: Nexo has a section of its own where past
 * conversations are listed, and a conversation started from the launcher has
 * to still be there when the user opens that page. A conversation belongs to
 * one Nexo: naming another Nexo's conversation starts a fresh one rather than
 * mixing histories. Every failure degrades to null — the turn still runs, it
 * just won't be remembered.
 */
async function resolveConversation(
  body: NexoTurnBody,
  storage: Storage,
  userId: string | null,
  nexoId: string | null,
): Promise<string | null> {
  if (!userId || storage.backend !== "supabase") return null;
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  try {
    if (body.conversationId) {
      const conv = await getConversationById(body.conversationId, userId);
      if (!conv || conv.workspace_id !== storage.workspace.id || conv.nexo_id !== nexoId) return null;
      if (lastUser) {
        await appendMessage(conv.id, { role: "user", content: lastUser.content });
        if (!conv.title) {
          const title = titleFromFirstMessage(lastUser.content);
          if (title) await renameConversation(conv.id, userId, title);
        }
      }
      return conv.id;
    }
    const created = await createConversation(
      storage.workspace.id,
      userId,
      lastUser ? titleFromFirstMessage(lastUser.content) : null,
      nexoId,
    );
    if (lastUser) {
      await appendMessage(created.id, { role: "user", content: lastUser.content });
    }
    return created.id;
  } catch {
    return null;
  }
}

/** Compact, JSON-safe metadata captured from the stream's finish event. */
function finishMetadata(event: {
  reasoningText?: string;
  finishReason?: string;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (event.reasoningText) meta.reasoning = event.reasoningText;
  if (event.finishReason) meta.finish_reason = event.finishReason;
  return meta;
}

function noGatewayNote(nodeCount: number, openNode: KnowledgeNode | null): string {
  return [
    "I can see the workspace, but I have no model to think with — set `AI_GATEWAY_API_KEY` or `OPENAI_BASE_URL` in `.env.local` and I'll wake up.",
    "",
    `_${nodeCount} node(s) in view${openNode ? `; you have "${openNode.title}" open` : ""}._`,
  ].join("\n");
}

/**
 * Confirm in prod logs that Anthropic's prompt cache is firing. Now that the
 * static block carries no nodes it should survive navigation, so a low hit
 * rate here means the gateway is stripping `cache_control`.
 */
function logCacheUsage(
  metadata: Record<string, Record<string, unknown>> | undefined,
  workspaceSlug: string,
): void {
  const anth = metadata?.anthropic;
  if (!anth) return;
  const read = pickNumber(anth.cacheReadInputTokens, anth.cache_read_input_tokens);
  const created = pickNumber(
    anth.cacheCreationInputTokens,
    anth.cache_creation_input_tokens,
  );
  if (read > 0) {
    log.info("nexo.cache_hit", {
      workspace: workspaceSlug,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: created,
    });
  }
}

function pickNumber(...candidates: unknown[]): number {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return 0;
}
