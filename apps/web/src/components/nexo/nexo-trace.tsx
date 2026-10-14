"use client";

/**
 * What Nexo did, while it does it.
 *
 * Live, the current step reads as a line of shimmer ("Searching the graph:
 * “pricing”", "Editing 4f2a…#goal"). Once the answer lands the whole run
 * collapses into `N steps`, expandable per call with its arguments and result.
 * Reasoning, when the model emits any, sits above in its own collapsed
 * disclosure.
 */
import { ChainOfThought } from "@/components/ui/chat/chain-of-thought";
import { ChatTool, ChatToolGroup, type ToolPartState } from "@/components/ui/chat/chat-tool";
import { Markdown } from "@/components/ui/chat/markdown";
import { TextShimmer } from "@/components/ui/chat/text-shimmer";
import type { ToolStep } from "@/lib/nexo/stream";

function toolState(status: ToolStep["status"]): ToolPartState {
  switch (status) {
    case "running":
      return "input-streaming";
    case "error":
      return "output-error";
    default:
      return "output-available";
  }
}

export function NexoTrace({
  steps,
  isStreaming,
  hasContent,
  reasoning,
}: {
  steps: ToolStep[];
  isStreaming: boolean;
  hasContent: boolean;
  reasoning?: string;
}) {
  const lastRunning = [...steps].reverse().find((s) => s.status === "running");
  const showLive = isStreaming && (lastRunning || !hasContent);
  const hasReasoning = Boolean(reasoning && reasoning.trim());

  if (!steps.length && !showLive && !hasReasoning) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {hasReasoning && (
        <ChainOfThought defaultExpanded={false} isStreaming={isStreaming && !hasContent}>
          <ChainOfThought.Trigger className="self-start">
            {isStreaming && !hasContent ? "Thinking…" : "Reasoning"}
          </ChainOfThought.Trigger>
          <ChainOfThought.Content>
            <ChainOfThought.Steps>
              <ChainOfThought.Step>
                <div className="chat-md">
                  <Markdown>{reasoning ?? ""}</Markdown>
                </div>
              </ChainOfThought.Step>
            </ChainOfThought.Steps>
          </ChainOfThought.Content>
        </ChainOfThought>
      )}

      {showLive ? (
        <TextShimmer className="self-start">
          {lastRunning?.summary ?? "Thinking…"}
        </TextShimmer>
      ) : steps.length > 0 ? (
        <ChatToolGroup defaultExpanded={false}>
          <ChatToolGroup.Trigger className="self-start">
            {steps.length === 1 ? "1 step" : `${steps.length} steps`}
          </ChatToolGroup.Trigger>
          <ChatToolGroup.Content>
            {steps.map((step) => (
              <ChatTool
                key={step.id}
                defaultExpanded={false}
                state={toolState(step.status)}
                toolName={step.name}
              >
                <ChatTool.Trigger>
                  <ChatTool.StatusIcon />
                  {step.summary}
                </ChatTool.Trigger>
                <ChatTool.Content>
                  <ChatTool.Args input={step.input} label="Input" />
                  {step.detail ? (
                    step.status === "error" ? (
                      <ChatTool.Error errorText={step.detail} />
                    ) : (
                      <ChatTool.Result label="Result" value={step.detail} />
                    )
                  ) : null}
                </ChatTool.Content>
              </ChatTool>
            ))}
          </ChatToolGroup.Content>
        </ChatToolGroup>
      ) : null}
    </div>
  );
}
