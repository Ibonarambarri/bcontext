"use client";

/**
 * ChatSources and ChatSource — the citations under an assistant answer
 * (`nexo-conversation.tsx` → `NodeSources`): a muted "N sources" disclosure
 * that opens onto a wrap of small pill-shaped source chips.
 *
 * A source with an `href` renders as a real link, so middle-click and "open
 * in new tab" work; the caller's `onClick` can still intercept a plain click
 * (Nexo opens the node in the side panel instead of navigating).
 */
import { createContext, useContext, type ComponentProps, type HTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { Disclosure } from "@heroui/react";
import { FileText, Globe } from "lucide-react";
import { cn } from "@bcontext-dev/contract/utils";

type SourceType = "url" | "document";

function SourcesRoot({
  className,
  children,
  ...rest
}: Omit<ComponentProps<typeof Disclosure>, "children" | "className"> & { className?: string; children?: ReactNode }) {
  return (
    <Disclosure
      data-slot="chat-sources"
      className={cn("w-full [&_[data-slot=disclosure-heading]]:w-full", className)}
      {...rest}
    >
      {children}
    </Disclosure>
  );
}

function SourcesTrigger({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <Disclosure.Heading>
      <Disclosure.Trigger
        data-slot="chat-sources-trigger"
        className={cn(
          "inline-flex min-h-8 w-fit cursor-pointer items-center gap-2 px-0 py-1 text-start text-xs font-medium text-muted transition-colors hover:text-foreground",
          className,
        )}
      >
        <span className="inline-flex min-w-0 items-center gap-2">{children}</span>
        <Disclosure.Indicator className="size-3.5 shrink-0 text-muted" />
      </Disclosure.Trigger>
    </Disclosure.Heading>
  );
}

function SourcesContent({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <Disclosure.Content
      data-slot="chat-sources-content"
      className={cn("border-t-0 border-default data-[expanded=true]:border-t", className)}
    >
      <Disclosure.Body>
        <div className="pt-2">{children}</div>
      </Disclosure.Body>
    </Disclosure.Content>
  );
}

function SourcesList({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="chat-sources-list" className={cn("flex flex-wrap items-center gap-2", className)} {...rest} />;
}

export const ChatSources = Object.assign(SourcesRoot, {
  Trigger: SourcesTrigger,
  Content: SourcesContent,
  List: SourcesList,
});

const SourceContext = createContext<{ href?: string; title?: string; sourceType: SourceType }>({
  sourceType: "url",
});

/**
 * `description` (the cited snippet) becomes the chip's native tooltip: the
 * chip has no hover card of its own.
 */
function SourceRoot({
  href,
  title,
  sourceType = href ? "url" : "document",
  description,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  href?: string;
  title?: string;
  description?: string;
  sourceType?: SourceType;
}) {
  return (
    <SourceContext.Provider value={{ href, title, sourceType }}>
      <div
        data-slot="chat-source"
        title={description}
        data-source-type={sourceType}
        className={cn("inline-flex h-5 items-center", className)}
        {...rest}
      >
        {children ?? (
          <SourceTrigger>
            <SourceTitle />
          </SourceTrigger>
        )}
      </div>
    </SourceContext.Provider>
  );
}

function SourceTrigger({
  className,
  children,
  onClick,
}: {
  className?: string;
  children?: ReactNode;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const { href, sourceType } = useContext(SourceContext);
  const Icon = sourceType === "document" ? FileText : Globe;
  const chip =
    "inline-flex h-5 max-w-32 items-center gap-1 overflow-hidden rounded-full bg-default px-1.5 text-xs leading-none text-muted no-underline transition-colors hover:bg-default-hover hover:text-foreground";
  const body = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0 rounded-full" />
      {children}
    </>
  );
  return (
    <span data-slot="chat-source-trigger" className={cn("inline-flex h-5 max-w-full items-center", className)}>
      {href ? (
        <a
          href={href}
          className={chip}
          onClick={onClick}
          {...(sourceType === "url" ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        >
          {body}
        </a>
      ) : (
        <span className={chip} onClick={onClick}>
          {body}
        </span>
      )}
    </span>
  );
}

function SourceTitle({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  const { title } = useContext(SourceContext);
  return (
    <span
      data-slot="chat-source-title"
      className={cn("min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-start font-normal", className)}
      {...rest}
    >
      {children ?? title}
    </span>
  );
}

export const ChatSource = Object.assign(SourceRoot, { Trigger: SourceTrigger, Title: SourceTitle });
