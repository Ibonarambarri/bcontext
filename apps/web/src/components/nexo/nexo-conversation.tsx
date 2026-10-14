"use client";

/**
 * The conversation — identical whether Nexo is in the corner or in its own
 * page, so it is written once and mounted twice.
 *
 * Built on the chat kit in `components/ui/chat` rather than around it: `ChatConversation` owns the
 * stick-to-bottom behaviour and the jump-to-bottom button, `ChatMessage` owns
 * the assistant/user anatomy, `PromptSuggestion` the empty state, `ChatSource`
 * the citations, `ChatLoader` the wait, and `PromptInput` the composer with its
 * own send/stop states. Styling stays out of the way — the kit is drawn with
 * HeroUI's tokens, which `globals.css` bridges onto the app's palette, so the
 * defaults are the house style.
 */
import { useEffect, useMemo, useState } from "react";
import { ChatConversation } from "@/components/ui/chat/chat-conversation";
import { ChatLoader } from "@/components/ui/chat/chat-loader";
import { ChatMessage, ChatMessageActions } from "@/components/ui/chat/chat-message";
import { ChatSource, ChatSources } from "@/components/ui/chat/chat-source";
import { PromptInput } from "@/components/ui/chat/prompt-input";
import { PromptSuggestion } from "@/components/ui/chat/prompt-suggestion";
import { Button, Chip, Tooltip } from "@heroui/react";
import { X } from "lucide-react";
import { cn } from "@bcontext-dev/contract/utils";
import type { ChatCitation } from "@bcontext-dev/contract/types";
import type { AskUserToolInput } from "@bcontext-dev/contract/nexo/assistant";
import { nodeDeepLink } from "@/lib/view-shell";
import { useWorkspace } from "../workspace-context";
import { NexoAvatar, type NexoMood } from "./nexo-avatar";
import { NexoMarkdown } from "./nexo-markdown";
import { NexoTrace } from "./nexo-trace";
import { useNexo, type NexoMessage, type NexoPersona } from "./nexo-session";
import { NexoFace } from "../nexos/nexo-face";

export function NexoConversation({ variant }: { variant: "panel" | "page" }) {
  const {
    messages,
    loading,
    historyLoading,
    send,
    answer,
    stop,
    selection,
    clearSelection,
    persona,
  } = useNexo();
  const { selectNode, nodes, inspectedNodeId, activeNodeId } = useWorkspace();
  const [input, setInput] = useState("");
  const page = variant === "page";

  const openNodeId = inspectedNodeId ?? activeNodeId;
  const openNodeTitle = useMemo(
    () => (openNodeId ? nodes.find((node) => node.id === openNodeId)?.title ?? null : null),
    [nodes, openNodeId],
  );

  // A selection is a claim about what the next message is about, so it takes
  // the focus with it.
  useEffect(() => {
    if (selection) {
      const el = document.querySelector<HTMLTextAreaElement>(".prompt-input__textarea");
      el?.focus();
    }
  }, [selection]);

  const submit = (value: string) => {
    const text = value.trim();
    if (!text) return;
    send(text);
    setInput("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatConversation className={cn("min-h-0 flex-1", page ? "px-6 pt-6" : "px-3 pt-3")}>
        <ChatConversation.Content
          className={cn("gap-6 px-0", page && "mx-auto w-full max-w-[760px]")}
        >
          {historyLoading ? (
            <ChatLoader.Skeleton />
          ) : messages.length === 0 ? (
            <NexoSuggestions
              persona={persona}
              openNodeTitle={openNodeTitle}
              hasSelection={Boolean(selection)}
              onPick={submit}
            />
          ) : (
            messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                isStreaming={
                  loading &&
                  messages.at(-1)?.id === message.id &&
                  message.role === "assistant"
                }
                // The face beside the newest message is the one you are
                // talking to, so that one follows the cursor.
                isLatest={messages.at(-1)?.id === message.id}
                persona={persona}
                onAnswer={(label) => answer(message.id, label)}
                onOpenNode={(nodeId, blockId) => selectNode(nodeId, { blockId })}
              />
            ))
          )}
        </ChatConversation.Content>
        <ChatConversation.ScrollButton />
        <ChatConversation.ScrollAnchor />
      </ChatConversation>

      <div className={cn(page ? "px-6 pb-5" : "px-3 pb-3")}>
        <div className={cn(page && "mx-auto w-full max-w-[760px]")} data-tour={page ? "nexo-composer" : undefined}>
          <PromptInput
            status={loading ? "streaming" : "ready"}
            value={input}
            onValueChange={setInput}
            onSubmit={() => submit(input)}
            onStop={stop}
            variant="secondary"
            maxHeight={200}
          >
            <PromptInput.Shell>
              <PromptInput.Content>
                <PromptInput.TextArea
                  aria-label={`Message ${persona?.name ?? "Nexo"}`}
                  placeholder={
                    selection
                      ? "What should I do with the selection?"
                      : `Ask ${persona?.name ?? "Nexo"}…`
                  }
                />
              </PromptInput.Content>
              <PromptInput.Toolbar>
                <PromptInput.ToolbarStart>
                  <ContextChips
                    openNodeTitle={openNodeTitle}
                    selection={selection?.text ?? null}
                    onClearSelection={clearSelection}
                  />
                </PromptInput.ToolbarStart>
                <PromptInput.ToolbarEnd>
                  <PromptInput.Send aria-label={loading ? "Stop" : "Send"} />
                </PromptInput.ToolbarEnd>
              </PromptInput.Toolbar>
            </PromptInput.Shell>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}

/**
 * What Nexo can see, said out loud above the composer. The open node is a
 * statement of fact; the selection is the one the user can retract.
 */
function ContextChips({
  openNodeTitle,
  selection,
  onClearSelection,
}: {
  openNodeTitle: string | null;
  selection: string | null;
  onClearSelection: () => void;
}) {
  if (!openNodeTitle && !selection) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {openNodeTitle ? (
        <Chip size="sm" variant="soft" className="max-w-[180px]">
          <Chip.Label className="truncate">{openNodeTitle}</Chip.Label>
        </Chip>
      ) : null}
      {selection ? (
        <>
          <Chip size="sm" variant="soft" color="accent" className="max-w-[220px]">
            <Chip.Label className="truncate">{selection}</Chip.Label>
          </Chip>
          <Tooltip delay={400}>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={onClearSelection}
              aria-label="Drop the selection"
            >
              <X size={12} />
            </Button>
            <Tooltip.Content>Drop the selection</Tooltip.Content>
          </Tooltip>
        </>
      ) : null}
    </div>
  );
}

/**
 * The empty state doubles as an offer. The suggestions change with the page:
 * with a node open they are about that node, which is the whole reason Nexo
 * knows where you are.
 */
function NexoSuggestions({
  persona,
  openNodeTitle,
  hasSelection,
  onPick,
}: {
  persona: NexoPersona | null;
  openNodeTitle: string | null;
  hasSelection: boolean;
  onPick: (prompt: string) => void;
}) {
  const prompts = hasSelection
    ? [
        "Rewrite the selection, shorter",
        "Explain what this means",
        "Turn this into a decision",
      ]
    : persona
      ? [
          "What happened since yesterday?",
          "What is waiting for me?",
          "What did you learn this week?",
          "Draft your checklist for today",
        ]
      : openNodeTitle
      ? [
          "What is this node about?",
          "Summarise it in three bullets",
          "What does it relate to?",
          "Draft a task from it",
        ]
      : [
          "What are we working on right now?",
          "Find what we wrote about pricing",
          "Which tasks are unblocked?",
          "Create a task for…",
        ];

  return (
    <PromptSuggestion className="@container">
      <PromptSuggestion.Header>
        <PromptSuggestion.Title>
          {persona
            ? `Talk to ${persona.name}`
            : openNodeTitle
              ? `Ask about “${openNodeTitle}”`
              : "What do you need?"}
        </PromptSuggestion.Title>
        <PromptSuggestion.Description>
          {persona
            ? `${persona.name} answers from the brain and from the sources it watches.`
            : "Nexo can see where you are, search the graph, and change it."}
        </PromptSuggestion.Description>
      </PromptSuggestion.Header>
      {/* Two columns only when the conversation itself is wide enough: the
          page beside the history column at 820px is not, and the viewport
          breakpoints the component uses cannot tell. */}
      <PromptSuggestion.Items className="!grid-cols-1 @[34rem]:!grid-cols-2">
        {prompts.map((prompt) => (
          <PromptSuggestion.Item key={prompt} onPress={() => onPick(prompt)}>
            {prompt}
          </PromptSuggestion.Item>
        ))}
      </PromptSuggestion.Items>
    </PromptSuggestion>
  );
}

function Message({
  message,
  isStreaming,
  isLatest,
  persona,
  onAnswer,
  onOpenNode,
}: {
  message: NexoMessage;
  persona: NexoPersona | null;
  isStreaming: boolean;
  isLatest: boolean;
  onAnswer: (label: string) => void;
  onOpenNode: (nodeId: string, blockId: string | null) => void;
}) {
  if (message.role === "user") {
    return (
      <ChatMessage.User>
        <ChatMessage.Bubble>
          <ChatMessage.Content className="whitespace-pre-wrap">
            {message.content}
          </ChatMessage.Content>
        </ChatMessage.Bubble>
      </ChatMessage.User>
    );
  }

  const citations = message.citations ?? [];
  const steps = message.steps ?? [];
  const waiting = isStreaming && !message.content && steps.length === 0;
  const choices = message.choices ?? null;
  const mood: NexoMood = message.failed
    ? "error"
    : choices
      ? "asking"
      : waiting
        ? "thinking"
        : isStreaming
          ? "speaking"
          : "idle";

  return (
    <ChatMessage.Assistant>
      {/* Nexo's face is neither a string nor an image, so it goes straight
          into the avatar slot (`chat-message__avatar`, see ui/chat/chat.css). */}
      {persona ? (
        <NexoFace name={persona.name} size={24} className="chat-message__avatar" />
      ) : (
        <NexoAvatar
          size={24}
          mood={mood}
          tracksCursor={isLatest}
          className="chat-message__avatar"
        />
      )}
      <ChatMessage.Body>
        <NexoTrace
          steps={steps}
          isStreaming={isStreaming}
          hasContent={Boolean(message.content)}
          reasoning={message.reasoning}
        />
        {waiting ? (
          <ChatLoader.Dots />
        ) : (
          <ChatMessage.Content>
            <NexoMarkdown
              content={message.content}
              isStreaming={isStreaming}
              citations={citations}
              onOpenNode={onOpenNode}
            />
          </ChatMessage.Content>
        )}
        {choices ? <Choices choices={choices} onAnswer={onAnswer} /> : null}
        {citations.length > 0 && !isStreaming ? (
          <NodeSources citations={citations} onOpenNode={onOpenNode} />
        ) : null}
        {message.content && !isStreaming ? (
          <ChatMessageActions>
            <ChatMessageActions.Copy
              aria-label="Copy message"
              tooltip="Copy"
              onPress={() => void navigator.clipboard?.writeText(message.content)}
            />
          </ChatMessageActions>
        ) : null}
      </ChatMessage.Body>
    </ChatMessage.Assistant>
  );
}

/**
 * A question Nexo asked, with its answers as buttons. Two to four whole
 * answers beat a paragraph of "did you mean…", and the pick goes back as an
 * ordinary message so the thread still reads as a conversation afterwards.
 */
function Choices({
  choices,
  onAnswer,
}: {
  choices: AskUserToolInput;
  onAnswer: (label: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-foreground">{choices.question}</p>
      <div className="flex flex-wrap gap-1.5">
        {choices.options.map((option) => (
          <Button
            key={option.label}
            size="sm"
            variant="outline"
            onPress={() => onAnswer(option.label)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * The nodes an answer came from, grouped behind one trigger. They are real
 * links to the node page — so middle-click and "open in new tab" behave — but
 * a plain click opens the node in the panel beside the conversation instead of
 * navigating away from it.
 */
function NodeSources({
  citations,
  onOpenNode,
}: {
  citations: ChatCitation[];
  onOpenNode: (nodeId: string, blockId: string | null) => void;
}) {
  const { address } = useWorkspace();
  return (
    <ChatSources defaultExpanded={false}>
      <ChatSources.Trigger>
        {citations.length === 1 ? "1 source" : `${citations.length} sources`}
      </ChatSources.Trigger>
      <ChatSources.Content>
        <ChatSources.List>
          {citations.map((citation, index) => (
            <ChatSource
              key={`${citation.node_id}-${index}`}
              sourceType="document"
              href={nodeDeepLink(address, citation.node_id)}
              title={citation.title}
              description={citation.snippet || undefined}
            >
              <ChatSource.Trigger
                onClick={(event) => {
                  event.preventDefault();
                  onOpenNode(citation.node_id, citation.block_id);
                }}
              >
                <ChatSource.Title>{citation.title}</ChatSource.Title>
              </ChatSource.Trigger>
            </ChatSource>
          ))}
        </ChatSources.List>
      </ChatSources.Content>
    </ChatSources>
  );
}
