"use client";

/**
 * ChatConversation — the scrolling log of a chat (`nexo-conversation.tsx`).
 *
 * It sticks to the bottom: while the reader is at the end, any growth of the
 * content (a streamed token, a new message, an expanded trace) scrolls with
 * it; once they scroll up to read, it stops following and `.ScrollButton`
 * appears to jump back. "At the bottom" is measured, never assumed, and a
 * programmatic scroll in flight is not mistaken for the reader leaving.
 * Top and bottom edges fade out through a mask so text slides under them.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type UIEvent,
} from "react";
import { Button } from "@heroui/react";
import { ChevronDown } from "lucide-react";
import { cn } from "@bcontext-dev/contract/utils";

/** Pixels of slack: sub-pixel rounding must not read as "scrolled up". */
const SLACK = 4;

const FADE =
  "linear-gradient(to bottom, transparent, black 32px, black calc(100% - 32px), transparent), linear-gradient(black, black)";

interface ConversationState {
  hasOverflow: boolean;
  isAtBottom: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** Called by the content when it resizes. */
  onContentResize: () => void;
}

const ConversationContext = createContext<ConversationState | null>(null);

function measure(el: HTMLElement) {
  const hasOverflow = el.scrollHeight - el.clientHeight > SLACK;
  const isAtBottom = !hasOverflow || el.scrollHeight - el.scrollTop - el.clientHeight <= SLACK;
  return { hasOverflow, isAtBottom };
}

function Root({ className, style, onScroll, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ hasOverflow: false, isAtBottom: true });
  // Read synchronously by the resize path, which runs between renders.
  const atBottomRef = useRef(true);
  // True while our own scrollTo is travelling, so its scroll events do not
  // flip "at bottom" off halfway through a smooth scroll.
  const autoScrolling = useRef(false);
  const lastTop = useRef(0);
  const frame = useRef<number | null>(null);

  const commit = useCallback((next: { hasOverflow: boolean; isAtBottom: boolean }) => {
    atBottomRef.current = next.isAtBottom;
    setState((prev) =>
      prev.hasOverflow === next.hasOverflow && prev.isAtBottom === next.isAtBottom ? prev : next,
    );
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = ref.current;
    if (!el) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    autoScrolling.current = true;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      el.scrollTo({ top: el.scrollHeight, behavior });
    });
  }, []);

  const onContentResize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const wasAtBottom = atBottomRef.current;
    const measured = measure(el);
    commit({ hasOverflow: measured.hasOverflow, isAtBottom: wasAtBottom || measured.isAtBottom });
    if (wasAtBottom) scrollToBottom("smooth");
  }, [commit, scrollToBottom]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  // Open at the end of the thread, not at its first message.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    lastTop.current = el.scrollTop;
    scrollToBottom("auto");
  }, [scrollToBottom]);

  // The viewport itself can change size (panel resized, composer grew).
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(onContentResize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onContentResize]);

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      onScroll?.(event);
      const el = event.currentTarget;
      const movedUp = el.scrollTop < lastTop.current - 1;
      lastTop.current = el.scrollTop;
      const measured = measure(el);
      if (autoScrolling.current && !movedUp) {
        if (measured.isAtBottom) autoScrolling.current = false;
        commit({ hasOverflow: measured.hasOverflow, isAtBottom: true });
        return;
      }
      autoScrolling.current = false;
      commit(measured);
    },
    [commit, onScroll],
  );

  const value = useMemo(
    () => ({ ...state, scrollToBottom, onContentResize }),
    [state, scrollToBottom, onContentResize],
  );

  return (
    <ConversationContext.Provider value={value}>
      <div
        ref={ref}
        role="log"
        data-slot="chat-conversation"
        onScroll={handleScroll}
        className={cn("relative flex min-h-0 flex-1 flex-col overflow-y-auto text-sm", className)}
        style={{
          // The second layer keeps the scrollbar strip (right 10px) unmasked.
          maskImage: FADE,
          WebkitMaskImage: FADE,
          maskPosition: "0 0, 100% 0",
          WebkitMaskPosition: "0 0, 100% 0",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskSize: "calc(100% - 10px) 100%, 10px 100%",
          WebkitMaskSize: "calc(100% - 10px) 100%, 10px 100%",
          ...style,
        }}
        {...rest}
      >
        {children}
      </div>
    </ConversationContext.Provider>
  );
}

function Content({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const ctx = useContext(ConversationContext);
  const ref = useRef<HTMLDivElement>(null);
  const onResize = ctx?.onContentResize;

  useEffect(() => {
    const el = ref.current;
    if (!el || !onResize || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(onResize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onResize]);

  return (
    <div
      ref={ref}
      data-slot="chat-conversation-content"
      className={cn("mx-auto flex w-full flex-col", className)}
      {...rest}
    />
  );
}

function ScrollAnchor({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      data-slot="chat-conversation-scroll-anchor"
      className={cn("h-px w-full shrink-0 scroll-mt-4", className)}
      {...rest}
    />
  );
}

function ScrollButton({ className, "aria-label": ariaLabel = "Scroll to the latest message" }: { className?: string; "aria-label"?: string }) {
  const ctx = useContext(ConversationContext);
  if (!ctx) return null;
  const visible = ctx.hasOverflow && !ctx.isAtBottom;
  return (
    <div
      aria-hidden={!visible || undefined}
      data-slot="chat-conversation-scroll-button-container"
      data-state={visible ? "visible" : "hidden"}
      className={cn("sticky bottom-4 z-10 mx-auto w-max", !visible && "pointer-events-none invisible")}
    >
      <Button
        isIconOnly
        size="sm"
        variant="secondary"
        aria-label={ariaLabel}
        isDisabled={!visible}
        onPress={() => ctx.scrollToBottom("smooth")}
        className={cn("border border-transparent bg-surface text-foreground shadow-surface dark:border-border", className)}
      >
        <ChevronDown className="size-4" />
      </Button>
    </div>
  );
}

export const ChatConversation = Object.assign(Root, { Content, ScrollAnchor, ScrollButton });
