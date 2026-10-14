"use client";

/**
 * One Nexo conversation session: the messages, the streaming turn, the
 * history list and what the server is told about where the person is.
 *
 * Used twice. `NexoProvider` (the shell) runs it against `/api/nexo` — the
 * general Nexo, shared by the launcher's panel and its page — and
 * `NexoScopeProvider` runs it against a specialist's `/api/nexos/:id/chat`
 * for that Nexo's Chat tab. Both speak the same NDJSON wire, so the turn
 * logic is written once and the endpoints are the only difference.
 *
 * Must stay free of the chat rendering stack (`ui/chat`, markdown):
 * the shell imports it synchronously and is on a gzip budget.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ChatCitation } from "@bcontext-dev/contract/types";
import type {
  AskUserToolInput,
  NexoSurface,
  PageContext,
  SelectionContext,
} from "@bcontext-dev/contract/nexo/assistant";
import { isNexoWriteTool } from "@bcontext-dev/contract/nexo/assistant";
import {
  consumeNdjsonStream,
  describeToolCall,
  describeToolOutput,
  outputIsError,
  type ToolStep,
} from "@/lib/nexo/stream";
import { customViewPath } from "@/lib/view-shell";
import { workspaceApiRef } from "@/web/workspace-url";
import { useWorkspace } from "../workspace-context";

export interface NexoMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps?: ToolStep[];
  reasoning?: string;
  citations?: ChatCitation[];
  /** A question Nexo asked with `ask_user`, still waiting for a pick. */
  choices?: AskUserToolInput | null;
  /** The turn ended badly — the avatar crosses its eyes and says why. */
  failed?: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  updated_at: string;
}

/** Who the conversation is with, when it is not the general Nexo. */
export interface NexoPersona {
  id: string;
  name: string;
}

export interface NexoSession {
  conversationId: string | null;
  messages: NexoMessage[];
  loading: boolean;
  /** Fetching a past conversation's messages — the surface shows a skeleton. */
  historyLoading: boolean;
  send: (text: string) => void;
  /** Answer an `ask_user` question by picking one of its options. */
  answer: (messageId: string, label: string) => void;
  stop: () => void;
  startNewConversation: () => void;
  openConversation: (id: string) => Promise<void>;
  conversations: ConversationSummary[];
  conversationsLoading: boolean;
  refreshConversations: () => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  /** What the server will be told about where the user is. */
  pageContext: (surface: NexoSurface) => PageContext;
}

export interface NexoCtx extends NexoSession {
  /** Is the floating panel showing? The page does not need this. */
  open: boolean;
  openNexo: () => void;
  closeNexo: () => void;
  toggleNexo: () => void;
  /** Panel width in px, dragged by the user and persisted per browser. */
  width: number;
  setWidth: (px: number) => void;
  /** Take the live session to the other window. Null when there is no other window. */
  sendToWidget: (() => void) | null;
  openInPage: () => void;
  /** The user's current text selection, offered to Nexo as context. */
  selection: SelectionContext | null;
  clearSelection: () => void;
  /** A specialist Nexo; null for the general one. */
  persona: NexoPersona | null;
}

export const NexoContext = createContext<NexoCtx | null>(null);

export function useNexo(): NexoCtx {
  const ctx = useContext(NexoContext);
  if (!ctx) throw new Error("useNexo must be used inside <NexoProvider>");
  return ctx;
}

/** Ids of what is on screen, capped to what the contract accepts. */
const MAX_VISIBLE = 60;

export interface NexoSessionConfig {
  /** Where a turn is POSTed. */
  chatUrl: string;
  /** Where the history list is read; answers `{conversations}` or `{sessions}`. */
  listUrl: string;
  /** Which surface the next turn comes from. */
  surface: () => NexoSurface;
  selection: SelectionContext | null;
  /** The selection rode on a turn and must not ride on the next. */
  onSelectionConsumed: () => void;
}

export function useNexoSession(config: NexoSessionConfig): NexoSession {
  const { chatUrl, listUrl, surface, selection, onSelectionConsumed } = config;
  const {
    address,
    inspectedNodeId,
    inspectedBlockId,
    activeNodeId,
    activeView,
    activeViewSlug,
    activeViewResult,
    selectNode,
    toast,
  } = useWorkspace();
  const router = useRouter();

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<NexoMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const wsRef = workspaceApiRef(address);

  // -- Conversations ---------------------------------------------------------

  const refreshConversations = useCallback(async () => {
    setConversationsLoading(true);
    try {
      const res = await fetch(listUrl, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        conversations?: ConversationSummary[];
        sessions?: ConversationSummary[];
      };
      setConversations(data.conversations ?? data.sessions ?? []);
    } catch {
      // History is a convenience; failing to list it must not break the turn.
    } finally {
      setConversationsLoading(false);
    }
  }, [listUrl]);

  const openConversation = useCallback(
    async (id: string) => {
      abortRef.current?.abort();
      setLoading(false);
      setConversationId(id);
      setMessages([]);
      setHistoryLoading(true);
      try {
        const res = await fetch(`/api/nexo/conversations/${encodeURIComponent(id)}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          messages?: { id: string; role: string; content: string; metadata?: unknown }[];
        };
        setMessages(
          (data.messages ?? [])
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
              reasoning: readReasoning(m.metadata),
            })),
        );
      } catch {
        toast.error("Couldn't open that conversation");
      } finally {
        setHistoryLoading(false);
      }
    },
    [toast],
  );

  const startNewConversation = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
    setConversationId(null);
    setMessages([]);
  }, []);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      setConversations((current) => current.map((c) => (c.id === id ? { ...c, title } : c)));
      try {
        await fetch(`/api/nexo/conversations/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
      } catch {
        toast.error("Couldn't rename the conversation");
        void refreshConversations();
      }
    },
    [refreshConversations, toast],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      setConversations((current) => current.filter((c) => c.id !== id));
      if (id === conversationId) startNewConversation();
      try {
        await fetch(`/api/nexo/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch {
        toast.error("Couldn't delete the conversation");
        void refreshConversations();
      }
    },
    [conversationId, refreshConversations, startNewConversation, toast],
  );

  // -- Page context ----------------------------------------------------------

  const pageContext = useCallback(
    (from: NexoSurface): PageContext => {
      const openNodeId = inspectedNodeId ?? activeNodeId;
      const context: PageContext = { surface: from };
      if (typeof window !== "undefined") context.route = window.location.pathname;
      if (activeViewSlug) {
        context.view = {
          slug: activeViewSlug,
          ...(activeView?.name ? { label: activeView.name } : {}),
          ...(activeView?.presentation?.renderer
            ? { renderer: activeView.presentation.renderer }
            : {}),
        };
      }
      if (openNodeId) {
        context.open_node = {
          id: openNodeId,
          // A node reached through the floating panel is the case the old chat
          // could not see at all: `activeNodeId` is null there.
          surface: inspectedNodeId && !activeNodeId ? "panel" : "page",
          ...(inspectedBlockId ? { block_id: inspectedBlockId } : {}),
        };
      }
      if (selection) context.selection = selection;
      const visible = activeViewResult?.node_ids;
      if (visible?.length) context.visible_node_ids = visible.slice(0, MAX_VISIBLE);
      return context;
    },
    [
      activeNodeId,
      activeView,
      activeViewResult,
      activeViewSlug,
      inspectedBlockId,
      inspectedNodeId,
      selection,
    ],
  );

  // -- Acting on the app -----------------------------------------------------

  /**
   * Nexo drives the interface through ordinary tool calls: the server
   * acknowledges them and this is what actually happens. Navigation is silent
   * on purpose — the user asked to see something, so showing it is the answer,
   * not an event to announce.
   */
  const runClientTool = useCallback(
    (name: string, input: unknown) => {
      const args = (input ?? {}) as Record<string, unknown>;
      if (name === "open_node" && typeof args.node_id === "string") {
        selectNode(args.node_id, {
          blockId: typeof args.block_id === "string" ? args.block_id : null,
        });
        return;
      }
      if (name === "open_view" && typeof args.view_slug === "string") {
        router.push(customViewPath(address, args.view_slug));
      }
    },
    [address, router, selectNode],
  );

  /**
   * A write lands immediately and says so, with the way back attached. The
   * server hands us the previous body for exactly this; when it is too large
   * to carry, the toast still reports the change, just without the undo.
   */
  const announceWrite = useCallback(
    (name: string, output: unknown) => {
      const result = (output ?? {}) as Record<string, unknown>;
      if (result.ok !== true || typeof result.id !== "string") return;
      const title = typeof result.title === "string" ? result.title : "a node";
      const nodeId = result.id;
      const before = typeof result.before === "string" ? result.before : null;

      if (result.created === true) {
        toast.info(`Nexo created “${title}”`, {
          action: { label: "Open", onPress: () => selectNode(nodeId) },
        });
        return;
      }
      if (!isNexoWriteTool(name)) return;
      toast.info(`Nexo edited “${title}”`, {
        action: before
          ? {
              label: "Undo",
              onPress: () => {
                void fetch(`/api/nodes/${encodeURIComponent(nodeId)}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    workspace: wsRef,
                    content_md: before,
                    change_context: { source: "nexo-undo" },
                  }),
                })
                  .then((res) => {
                    if (!res.ok) throw new Error(String(res.status));
                    window.dispatchEvent(
                      new CustomEvent("bcontext:active-node-may-be-edited", {
                        detail: { nodeId },
                      }),
                    );
                  })
                  .catch(() => toast.error("Couldn't undo that change"));
              },
            }
          : { label: "Open", onPress: () => selectNode(nodeId) },
      });
    },
    [selectNode, toast, wsRef],
  );

  // -- The turn --------------------------------------------------------------

  const send = useCallback(
    (text: string) => {
      const content = text.trim();
      if (!content || loading) return;

      const userMessage: NexoMessage = { id: newId(), role: "user", content };
      const replyId = newId();
      const history = [...messages, userMessage];
      setMessages([...history, { id: replyId, role: "assistant", content: "" }]);
      setLoading(true);

      const controller = new AbortController();
      abortRef.current = controller;
      const context = pageContext(surface());
      onSelectionConsumed();

      // Everything below mutates through these locals, not React state, so a
      // burst of deltas is one render per event rather than one per token.
      let acc = "";
      let reasoning = "";
      let choices: AskUserToolInput | null = null;
      let failed = false;
      const steps: ToolStep[] = [];
      const flush = () => {
        setMessages((current) =>
          current.map((m) =>
            m.id === replyId
              ? {
                  ...m,
                  content: acc,
                  steps: steps.slice(),
                  choices,
                  failed,
                  ...(reasoning ? { reasoning } : {}),
                }
              : m,
          ),
        );
      };

      void (async () => {
        try {
          const res = await fetch(chatUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              workspace: wsRef,
              conversationId,
              pageContext: context,
              messages: history.map((m) => ({ role: m.role, content: m.content })),
            }),
          });

          if (!res.ok || !res.body) {
            // 402 is either a monthly AI limit or a specialist's own monthly
            // budget (`nexo_budget_exhausted`, with its own message).
            const refusal = res.status === 402 ? ((await res.json().catch(() => ({}))) as { error?: string; message?: string }) : {};
            const detail =
              refusal.error === "nexo_budget_exhausted"
                ? refusal.message || "This Nexo used its monthly budget."
                : res.status === 402
                  ? "The AI limit for this month is reached."
                  : "";
            throw new Error(detail || `Nexo answered ${res.status}`);
          }

          const newConversationId = res.headers.get("x-conversation-id");
          if (newConversationId && newConversationId !== conversationId) {
            setConversationId(newConversationId);
          }
          const citations = readCitations(res.headers.get("x-citations"));
          if (citations) {
            setMessages((current) =>
              current.map((m) => (m.id === replyId ? { ...m, citations } : m)),
            );
          }

          await consumeNdjsonStream(res.body, (event) => {
            switch (event.type) {
              case "text-delta":
                acc += event.text;
                flush();
                break;
              case "reasoning-delta":
                reasoning += event.text;
                flush();
                break;
              case "tool-call":
                steps.push({
                  id: event.toolCallId,
                  name: event.toolName,
                  input: event.input,
                  status: "running",
                  summary: describeToolCall(event.toolName, event.input),
                });
                if (event.toolName === "ask_user") {
                  choices = readAskUser(event.input);
                } else {
                  runClientTool(event.toolName, event.input);
                }
                flush();
                break;
              case "tool-result": {
                const step = steps.find((s) => s.id === event.toolCallId);
                if (step) {
                  step.status = outputIsError(event.output) ? "error" : "ok";
                  step.detail = describeToolOutput(event.toolName, event.output);
                }
                announceWrite(event.toolName, event.output);
                flush();
                break;
              }
              case "tool-error": {
                const step = steps.find((s) => s.id === event.toolCallId);
                if (step) {
                  step.status = "error";
                  step.detail = event.error;
                }
                flush();
                break;
              }
              case "error":
                acc += `\n\n_${event.message}_`;
                failed = true;
                flush();
                break;
              case "finish":
                break;
            }
          });

          // The node the user is looking at may be the one that just changed.
          const openNodeId = context.open_node?.id;
          if (openNodeId && steps.some((s) => isNexoWriteTool(s.name))) {
            window.dispatchEvent(
              new CustomEvent("bcontext:active-node-may-be-edited", {
                detail: { nodeId: openNodeId },
              }),
            );
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") return;
          acc += acc ? "\n\n" : "";
          acc += `_${(err as Error).message}_`;
          failed = true;
          flush();
        } finally {
          abortRef.current = null;
          setLoading(false);
          void refreshConversations();
        }
      })();
    },
    [
      announceWrite,
      chatUrl,
      conversationId,
      loading,
      messages,
      onSelectionConsumed,
      pageContext,
      refreshConversations,
      runClientTool,
      surface,
      wsRef,
    ],
  );

  /**
   * Picking an option is sending it. The buttons go first so a second click
   * cannot fire while the request is in flight.
   */
  const answer = useCallback(
    (messageId: string, label: string) => {
      setMessages((current) =>
        current.map((m) => (m.id === messageId ? { ...m, choices: null } : m)),
      );
      send(label);
    },
    [send],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  }, []);

  return useMemo(
    () => ({
      conversationId,
      messages,
      loading,
      historyLoading,
      send,
      answer,
      stop,
      startNewConversation,
      openConversation,
      conversations,
      conversationsLoading,
      refreshConversations,
      renameConversation,
      deleteConversation,
      pageContext,
    }),
    [
      answer,
      conversationId,
      conversations,
      conversationsLoading,
      deleteConversation,
      historyLoading,
      loading,
      messages,
      openConversation,
      pageContext,
      refreshConversations,
      renameConversation,
      send,
      startNewConversation,
      stop,
    ],
  );
}

function newId(): string {
  return `m-${Math.random().toString(36).slice(2, 10)}`;
}

/** Trust the shape, not the model: a malformed ask is no ask at all. */
function readAskUser(input: unknown): AskUserToolInput | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  const options = Array.isArray(raw.options)
    ? raw.options
        .map((option) => {
          const label =
            option && typeof option === "object"
              ? String((option as Record<string, unknown>).label ?? "").trim()
              : String(option ?? "").trim();
          return label ? { label } : null;
        })
        .filter((option): option is { label: string } => option !== null)
    : [];
  if (!question || options.length < 2) return null;
  return { question, options };
}

function readCitations(header: string | null): ChatCitation[] | null {
  if (!header) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(header)) as ChatCitation[];
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

function readReasoning(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>).reasoning;
  return typeof value === "string" && value ? value : undefined;
}
