"use client";

/**
 * PromptInput — the chat composer (`nexo-conversation.tsx`): an auto-growing
 * textarea in a rounded shell, with a toolbar pinned to the shell's bottom
 * edge (context chips at the start, the send/stop button at the end).
 *
 * Behaviour the caller relies on:
 * - Enter submits, Shift+Enter breaks the line.
 * - While `status` is "streaming"/"submitted" the textarea is locked and the
 *   send button becomes a stop button wired to `onStop`.
 * - The textarea carries the `prompt-input__textarea` class: Nexo focuses it
 *   by that selector when a selection is attached, so keep it.
 * - A click anywhere on the shell that is not a control focuses the textarea.
 */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
} from "react";
import { Button } from "@heroui/react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "@bcontext-dev/contract/utils";

type PromptStatus = "ready" | "submitted" | "streaming" | "error";

interface PromptInputState {
  value: string;
  setValue: (value: string) => void;
  status: PromptStatus;
  isBusy: boolean;
  maxHeight: number;
  variant: "primary" | "secondary";
  onSubmit?: () => void;
  onStop?: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

const PromptInputContext = createContext<PromptInputState | null>(null);

function usePromptInput(): PromptInputState {
  const ctx = useContext(PromptInputContext);
  if (!ctx) throw new Error("PromptInput parts must sit inside <PromptInput>");
  return ctx;
}

function Root({
  value,
  onValueChange,
  onSubmit,
  onStop,
  status = "ready",
  variant = "primary",
  maxHeight = 240,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "onSubmit"> & {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit?: () => void;
  onStop?: () => void;
  status?: PromptStatus;
  variant?: "primary" | "secondary";
  maxHeight?: number;
  children?: ReactNode;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isBusy = status === "streaming" || status === "submitted";
  return (
    <PromptInputContext.Provider
      value={{ value, setValue: onValueChange, status, isBusy, maxHeight, variant, onSubmit, onStop, textareaRef }}
    >
      <div
        data-slot="prompt-input"
        data-status={status}
        data-variant={variant}
        data-pending={isBusy || undefined}
        className={cn("group/prompt relative w-full", className)}
        {...rest}
      >
        {children}
      </div>
    </PromptInputContext.Provider>
  );
}

/** Controls that keep their own click instead of focusing the textarea. */
const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [data-slot="prompt-input-toolbar"]';

function Shell({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const { variant, textareaRef, isBusy } = usePromptInput();
  return (
    <div
      data-slot="prompt-input-shell"
      onClick={(event: MouseEvent<HTMLDivElement>) => {
        if ((event.target as HTMLElement).closest(INTERACTIVE)) return;
        textareaRef.current?.focus();
      }}
      className={cn(
        "relative flex w-full cursor-text flex-col overflow-hidden rounded-xl border border-field-border transition-[background-color,border-color,box-shadow] duration-150",
        variant === "secondary"
          ? "bg-default shadow-none [@media(hover:hover)]:hover:bg-default-hover focus-within:bg-default focus-within:border-field-border-focus"
          : "bg-field hover:border-field-border-hover focus-within:bg-field-focus focus-within:border-field-border-focus",
        isBusy && "opacity-95",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

function Content({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="prompt-input-content" className={cn("flex min-h-0 flex-1 flex-col gap-1", className)} {...rest} />;
}

function TextArea({
  className,
  onKeyDown,
  placeholder = "What do you want to know?",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { value, setValue, isBusy, maxHeight, onSubmit, textareaRef } = usePromptInput();

  // Grow with the text up to maxHeight, then scroll inside.
  const autosize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [maxHeight, textareaRef]);

  useLayoutEffect(autosize, [autosize, value]);

  return (
    <textarea
      ref={textareaRef}
      data-slot="prompt-input-textarea"
      rows={1}
      value={value}
      placeholder={placeholder}
      disabled={isBusy}
      aria-label={rest["aria-label"] ?? "Message input"}
      className={cn(
        "prompt-input__textarea mb-14 min-h-14 w-full resize-none border-0 bg-transparent px-3 pt-3 text-sm text-field-foreground shadow-none outline-none ring-0 transition-[height] duration-100 placeholder:text-field-placeholder disabled:cursor-not-allowed motion-reduce:transition-none",
        className,
      )}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (!isBusy) onSubmit?.();
        }
        onKeyDown?.(event);
      }}
      {...rest}
    />
  );
}

function Toolbar({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="prompt-input-toolbar"
      className={cn("absolute inset-x-3 bottom-3 flex cursor-default items-center justify-between gap-2", className)}
      {...rest}
    />
  );
}

function ToolbarStart({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="prompt-input-toolbar-start" className={cn("flex items-center gap-2", className)} {...rest} />;
}

function ToolbarEnd({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="prompt-input-toolbar-end" className={cn("flex items-center gap-2", className)} {...rest} />;
}

/** Send while ready (disabled on an empty draft); stop while busy, when there is an `onStop`. */
function Send({ className, "aria-label": ariaLabel }: { className?: string; "aria-label"?: string }) {
  const { value, isBusy, status, onSubmit, onStop } = usePromptInput();
  const canStop = isBusy && Boolean(onStop);
  const disabled = isBusy ? !canStop : !value.trim();
  return (
    <Button
      isIconOnly
      size="md"
      data-slot="prompt-input-send"
      data-status={status}
      aria-label={ariaLabel ?? (canStop ? "Stop" : "Send message")}
      isDisabled={disabled}
      onPress={() => (canStop ? onStop?.() : onSubmit?.())}
      className={cn("shrink-0", status === "error" && "bg-danger text-danger-foreground", className)}
    >
      {canStop ? <Square className="size-3.5 fill-current" /> : <ArrowUp className="size-4" />}
    </Button>
  );
}

export const PromptInput = Object.assign(Root, {
  Shell,
  Content,
  TextArea,
  Toolbar,
  ToolbarStart,
  ToolbarEnd,
  Send,
});
