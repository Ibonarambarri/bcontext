"use client";

/**
 * Nexo in the corner: a floating window beside the work, not on top of it.
 *
 * It shares the right edge with the node panel, which steps aside to make room
 * (`--nexo-w`, set by the shell and read by `node-floating-panel.tsx`). Drag its
 * left edge to resize; the node panel follows, live.
 *
 * On mobile there is no room to share, so it takes the surface.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, History, Plus, X } from "lucide-react";
import { Button, Surface, Tooltip } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { NexoAvatar } from "./nexo-avatar";
import { NexoConversation } from "./nexo-conversation";
import { NexoHistory } from "./nexo-history";
import { useNexo } from "./nexo-provider";

export function NexoPanel() {
  const { open, closeNexo, openInPage, startNewConversation, width, setWidth, loading } =
    useNexo();
  const isMobile = useIsMobile();
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    if (!open) setHistoryOpen(false);
  }, [open]);

  // Esc closes, unless the user is mid-sentence in the composer.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable),
      );
      if (typing) return;
      event.preventDefault();
      closeNexo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeNexo]);

  return (
    <Surface
      variant="default"
      role="dialog"
      aria-label="Nexo"
      aria-hidden={!open}
      data-nexo-panel
      className={cn(
        "absolute z-40 flex flex-col overflow-hidden rounded-xl border border-[var(--line)] p-0 shadow-xl transition-[transform,opacity] duration-200 ease-out",
        isMobile ? "inset-2" : "inset-y-3 right-3",
        open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-4 opacity-0",
      )}
      style={isMobile ? undefined : { width }}
    >
      {!isMobile && <ResizeHandle width={width} onResize={setWidth} />}
      <header className="flex shrink-0 items-center gap-1 pl-4 pr-2 py-2.5">
        <NexoAvatar size={20} mood={loading ? "thinking" : "idle"} tracksCursor />
        <div className="flex-1 text-sm font-medium text-foreground">Nexo</div>
        <PanelAction label="New conversation" onPress={startNewConversation}>
          <Plus size={13} />
        </PanelAction>
        <PanelAction
          label={historyOpen ? "Hide history" : "History"}
          onPress={() => setHistoryOpen((v) => !v)}
        >
          <History size={13} />
        </PanelAction>
        <PanelAction label="Open in the Nexo page" onPress={openInPage}>
          <ExternalLink size={13} />
        </PanelAction>
        <PanelAction label="Close" onPress={closeNexo}>
          <X size={13} />
        </PanelAction>
      </header>

      {open ? (
        historyOpen ? (
          <NexoHistory variant="panel" onPick={() => setHistoryOpen(false)} />
        ) : (
          <NexoConversation variant="panel" />
        )
      ) : null}
    </Surface>
  );
}

/**
 * The left edge, dragged. Pointer capture rather than window listeners so the
 * drag survives the cursor crossing the iframe-less parts of the page.
 */
function ResizeHandle({
  width,
  onResize,
}: {
  width: number;
  onResize: (px: number) => void;
}) {
  const startRef = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      startRef.current = { x: event.clientX, width };
    },
    [width],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = startRef.current;
      if (!start) return;
      onResize(start.width + (start.x - event.clientX));
    },
    [onResize],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    startRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Nexo"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="group absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize"
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-[var(--line-strong)]" />
    </div>
  );
}

function PanelAction({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip delay={400}>
      <Button isIconOnly size="sm" variant="ghost" onPress={onPress} aria-label={label}>
        {children}
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}
