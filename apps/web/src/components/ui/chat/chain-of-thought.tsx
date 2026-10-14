"use client";

/**
 * ChainOfThought — the model's reasoning, folded behind a quiet "Reasoning"
 * trigger above an answer (`nexo-trace.tsx`). A HeroUI Disclosure: the
 * trigger shimmers while `isStreaming`, the steps hang off a thin left rule.
 */
import { createContext, useContext, type ComponentProps, type HTMLAttributes, type ReactNode } from "react";
import { Button, Disclosure } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";
import { TextShimmer } from "./text-shimmer";

const StreamingContext = createContext(false);

function Root({
  isStreaming = false,
  className,
  children,
  ...rest
}: Omit<ComponentProps<typeof Disclosure>, "children"> & { isStreaming?: boolean; className?: string; children?: ReactNode }) {
  return (
    <StreamingContext.Provider value={isStreaming}>
      <Disclosure data-slot="chain-of-thought" className={cn("w-full text-sm", className)} {...rest}>
        {children}
      </Disclosure>
    </StreamingContext.Provider>
  );
}

function Trigger({ className, children }: { className?: string; children?: ReactNode }) {
  const isStreaming = useContext(StreamingContext);
  return (
    <Disclosure.Heading>
      <Button
        slot="trigger"
        size="sm"
        variant="ghost"
        data-slot="chain-of-thought-trigger"
        className={cn(
          "w-fit justify-start gap-2 bg-transparent px-0 font-normal text-muted transition-colors hover:bg-transparent hover:text-foreground active:scale-100 data-[pressed=true]:scale-100 data-[pressed=true]:bg-transparent",
          isStreaming && "text-foreground",
          className,
        )}
      >
        {isStreaming ? <TextShimmer>{children}</TextShimmer> : children}
        <Disclosure.Indicator className="size-3.5 text-muted" />
      </Button>
    </Disclosure.Heading>
  );
}

function Content({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <Disclosure.Content data-slot="chain-of-thought-content" className={className}>
      <Disclosure.Body>{children}</Disclosure.Body>
    </Disclosure.Content>
  );
}

function Steps({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="chain-of-thought-steps"
      className={cn("flex flex-col gap-3 border-s border-default ps-3", className)}
      {...rest}
    />
  );
}

function Step({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div data-slot="chain-of-thought-step" className={cn("flex flex-col gap-1", className)} {...rest}>
      <div className="leading-relaxed text-foreground">{children}</div>
    </div>
  );
}

export const ChainOfThought = Object.assign(Root, { Trigger, Content, Steps, Step });
