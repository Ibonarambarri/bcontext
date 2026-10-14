"use client";

/**
 * ChatMessage and ChatMessageActions — the anatomy of one turn in a chat
 * (`nexo-conversation.tsx`).
 *
 * A user turn is a right-aligned bubble; an assistant turn is a row of avatar
 * + body, with no bubble, so long answers read as a page. The avatar is the
 * caller's own element with the `chat-message__avatar` class (see chat.css).
 * `ChatMessageActions` is the row under an answer, faint until the turn is
 * hovered; `.Copy` swaps its icon to a check for two seconds after a press.
 */
import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import { Button, Tooltip } from "@heroui/react";
import { Check, Copy } from "lucide-react";
import { cn } from "@bcontext-dev/contract/utils";

type DivProps = HTMLAttributes<HTMLDivElement>;

function User({ className, ...rest }: DivProps) {
  return (
    <div
      data-slot="chat-message-user"
      className={cn("group/message flex w-full flex-col items-end", className)}
      {...rest}
    />
  );
}

function Assistant({ className, ...rest }: DivProps) {
  return (
    <div
      data-slot="chat-message-assistant"
      className={cn("group/message flex w-full flex-row items-start gap-3 py-2", className)}
      {...rest}
    />
  );
}

function Bubble({ className, ...rest }: DivProps) {
  return (
    <div
      data-slot="chat-message-bubble"
      className={cn("rounded-xl bg-default px-4 py-2 text-foreground", className)}
      {...rest}
    />
  );
}

function Body({ className, ...rest }: DivProps) {
  return (
    <div
      data-slot="chat-message-body"
      className={cn("flex min-w-0 flex-1 flex-col gap-2 pe-12", className)}
      {...rest}
    />
  );
}

function Content({ className, ...rest }: DivProps) {
  return (
    <div
      data-slot="chat-message-content"
      className={cn("w-full text-sm leading-relaxed text-foreground", className)}
      {...rest}
    />
  );
}

export const ChatMessage = { User, Assistant, Bubble, Body, Content };

function ActionsRoot({ className, ...rest }: DivProps) {
  return (
    <div
      data-slot="chat-message-actions"
      className={cn(
        "flex items-start opacity-50 transition-opacity [@media(hover:hover)]:group-hover/message:opacity-100",
        className,
      )}
      {...rest}
    />
  );
}

function CopyAction({
  "aria-label": ariaLabel,
  tooltip,
  onPress,
}: {
  "aria-label"?: string;
  tooltip?: string;
  onPress?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const button = (
    <Button
      isIconOnly
      size="sm"
      variant="ghost"
      aria-label={ariaLabel}
      data-slot="chat-message-action"
      className="text-muted"
      onPress={() => {
        onPress?.();
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          setCopied(false);
          timer.current = null;
        }, 2000);
      }}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip delay={0}>
      {button}
      <Tooltip.Content>{tooltip}</Tooltip.Content>
    </Tooltip>
  );
}

export const ChatMessageActions = Object.assign(ActionsRoot, { Copy: CopyAction });
