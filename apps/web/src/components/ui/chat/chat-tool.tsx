"use client";

/**
 * ChatTool and ChatToolGroup — one tool call an assistant made, and the "N
 * steps" fold that holds a run of them (`nexo-trace.tsx`).
 *
 * Both are bordered HeroUI Disclosures. A call's `state` follows the AI SDK's
 * tool-part vocabulary (`ToolPartState`) and decides the status icon, the
 * border tint and whether the trigger shimmers; the content shows the call's
 * input and result as JSON code blocks, or its error in the danger colour.
 */
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Disclosure } from "@heroui/react";
import { CircleAlert, CircleCheck, CircleX, Wrench, type LucideIcon } from "lucide-react";
import { cn } from "@bcontext-dev/contract/utils";
import { ChatCodeBlock } from "./chat-code-block";
import { TextShimmer } from "./text-shimmer";

export type ToolPartState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | "requires-action";

type DisclosureProps = Omit<ComponentProps<typeof Disclosure>, "children" | "className"> & {
  className?: string;
  children?: ReactNode;
};

const ToolContext = createContext<{ state: ToolPartState; active: boolean }>({
  state: "output-available",
  active: false,
});

/** Shared by both triggers: a full-width row that tints on hover. */
const TRIGGER =
  "inline-flex min-h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-none px-3 py-2 text-start text-xs font-normal text-foreground hover:bg-default data-[pressed=true]:bg-default";
const FRAME = "w-full overflow-hidden rounded-xl border border-default [&_[data-slot=disclosure-heading]]:w-full";

/** Anything not a string is shown as pretty JSON; the empty string means "nothing to show". */
function asText(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function Root({
  state = "output-available",
  toolName,
  className,
  children,
  ...rest
}: DisclosureProps & { state?: ToolPartState; toolName?: string }) {
  const active = state === "input-streaming" || state === "input-available";
  return (
    <ToolContext.Provider value={{ state, active }}>
      <Disclosure
        data-slot="chat-tool"
        data-state={state}
        data-tool-name={toolName}
        data-active={active || undefined}
        className={cn(
          FRAME,
          state === "output-error" && "border-danger/30",
          state === "requires-action" && "border-warning/40",
          className,
        )}
        {...rest}
      >
        {children}
      </Disclosure>
    </ToolContext.Provider>
  );
}

function Trigger({ className, children }: { className?: string; children?: ReactNode }) {
  const { active } = useContext(ToolContext);
  return (
    <Disclosure.Heading>
      <Disclosure.Trigger data-slot="chat-tool-trigger" className={cn(TRIGGER, className)}>
        <span className="flex min-w-0 items-center gap-2 text-xs font-normal">
          {active ? <TextShimmer className="inline-flex min-w-0 items-center gap-2">{children}</TextShimmer> : children}
        </span>
        <Disclosure.Indicator className="size-3.5 shrink-0 text-muted" />
      </Disclosure.Trigger>
    </Disclosure.Heading>
  );
}

const STATUS_ICON: Record<ToolPartState, LucideIcon> = {
  "input-streaming": Wrench,
  "input-available": Wrench,
  "output-available": CircleCheck,
  "output-error": CircleX,
  "requires-action": CircleAlert,
};

function StatusIcon({ className }: { className?: string }) {
  const { state } = useContext(ToolContext);
  const Icon = STATUS_ICON[state];
  return (
    <span data-slot="chat-tool-status" className={cn("inline-flex size-3.5 shrink-0 items-center justify-center text-muted", className)}>
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          state === "output-available" && "text-success",
          state === "output-error" && "text-danger",
          state === "requires-action" && "text-warning",
        )}
      />
    </span>
  );
}

function Content({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <Disclosure.Content data-slot="chat-tool-content" className={className}>
      <Disclosure.Body>
        <div className="flex flex-col gap-1 p-1">{children}</div>
      </Disclosure.Body>
    </Disclosure.Content>
  );
}

const LABEL = "mb-1 text-[10px] font-medium uppercase tracking-wide text-muted";
/** Tool payloads are dense: a smaller, tighter block than a message fence. */
const PAYLOAD_BLOCK = "my-1 rounded-xl [&_.chat-code-block__code]:text-[11px] [&_.chat-code-block__code]:leading-5 [&_.chat-code-block__code_pre]:px-2.5 [&_.chat-code-block__code_pre]:py-1.5";

function Args({ input, label, className }: { input?: unknown; label?: string; className?: string }) {
  const text = asText(input);
  if (!text) return null;
  return (
    <div data-slot="chat-tool-args" className={cn("text-xs", className)}>
      {label ? <div className={LABEL}>{label}</div> : null}
      <ChatCodeBlock code={text} language="json" showHeader={false} className={PAYLOAD_BLOCK} />
    </div>
  );
}

function Result({ value, label, className }: { value?: unknown; label?: string; className?: string }) {
  const { state } = useContext(ToolContext);
  if (state === "output-error" || value === undefined) return null;
  const text = asText(value);
  if (!text) return null;
  return (
    <div data-slot="chat-tool-result" className={cn("text-xs", className)}>
      {label ? <div className={LABEL}>{label}</div> : null}
      <ChatCodeBlock code={text} language="json" showHeader={false} className={PAYLOAD_BLOCK} />
    </div>
  );
}

function ErrorText({ errorText, label, className }: { errorText?: string; label?: string; className?: string }) {
  if (!errorText) return null;
  return (
    <div data-slot="chat-tool-error" className={cn("text-xs text-danger", className)}>
      {label ? <div className={LABEL}>{label}</div> : null}
      {errorText}
    </div>
  );
}

export const ChatTool = Object.assign(Root, {
  Trigger,
  StatusIcon,
  Content,
  Args,
  Result,
  Error: ErrorText,
});

function GroupRoot({ className, children, ...rest }: DisclosureProps) {
  return (
    <Disclosure data-slot="chat-tool-group" className={cn(FRAME, className)} {...rest}>
      {children}
    </Disclosure>
  );
}

function GroupTrigger({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <Disclosure.Heading>
      <Disclosure.Trigger data-slot="chat-tool-group-trigger" className={cn(TRIGGER, className)}>
        <span className="flex min-w-0 items-center gap-2 text-xs font-normal">{children}</span>
        <Disclosure.Indicator className="size-3.5 shrink-0 text-muted" />
      </Disclosure.Trigger>
    </Disclosure.Heading>
  );
}

function GroupContent({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <Disclosure.Content data-slot="chat-tool-group-content" className={className}>
      <Disclosure.Body>
        <div className="flex flex-col gap-1.5 p-1">{children}</div>
      </Disclosure.Body>
    </Disclosure.Content>
  );
}

export const ChatToolGroup = Object.assign(GroupRoot, { Trigger: GroupTrigger, Content: GroupContent });
