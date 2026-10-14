"use client";

/**
 * A Nexo's Chat tab (`nexos/nexo-detail.tsx`): conversations down the left,
 * the conversation itself in the middle and, for the general Nexo, one button
 * that takes the live session back to the corner so you can keep working with
 * it open beside you. A specialist's tab mounts the same page inside its own
 * `NexoScopeProvider`, so every word below applies to both.
 *
 * It is the same session the launcher shows — picking a conversation here is
 * what the panel will be showing when you press "Send to the panel".
 *
 * When Nexo opens a node from here, the node panel takes the right half of
 * the surface (always the half on this page, see `node-floating-panel.tsx`).
 * The page makes room instead of being covered: the history column steps out
 * and the conversation keeps the left half, so the answer and the node it
 * talks about sit side by side, the way they do in the widget.
 */
import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { PanelRight } from "lucide-react";
import { Button } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useWorkspace } from "../workspace-context";
import { NexoConversation } from "./nexo-conversation";
import { NexoHistory } from "./nexo-history";
import { useNexo } from "./nexo-provider";

/**
 * The node panel's half-width, as `node-floating-panel.tsx` computes it, plus
 * its right gutter. Nexo's own panel is closed on this page, so its share of
 * the edge is zero and the formula collapses to this.
 */
const NODE_PANEL_SPACE = "calc(50% - 18px + 0.75rem)";

export function NexoPage() {
  const { closeNexo, sendToWidget, openConversation, conversationId } = useNexo();
  const { inspectedNodeId, activeNodeId } = useWorkspace();
  const isMobile = useIsMobile();
  const params = useSearchParams();
  const requested = params.get("c");

  // On mobile the panel takes the surface; there is no half to share.
  const nodeBeside = Boolean(inspectedNodeId) && !activeNodeId && !isMobile;

  // The panel's "open in the page" carries the conversation in the URL, so the
  // link is shareable and a reload lands on the same conversation.
  useEffect(() => {
    if (requested && requested !== conversationId) void openConversation(requested);
  }, [requested, conversationId, openConversation]);

  // Two windows onto one session would be two scroll positions and two
  // composers arguing over the same stream.
  useEffect(() => {
    closeNexo();
  }, [closeNexo]);

  return (
    <div
      className="flex h-full min-h-0 transition-[padding] duration-200 ease-out"
      style={{ paddingRight: nodeBeside ? NODE_PANEL_SPACE : 0 }}
    >
      <div
        className={cn(
          "flex min-h-0 shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-out",
          nodeBeside ? "w-0 opacity-0" : "w-[264px] opacity-100",
        )}
        aria-hidden={nodeBeside}
      >
        <NexoHistory variant="page" />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Only the general Nexo has a panel to go back to; a specialist is
            talked to here, in its own tab. */}
        {sendToWidget ? (
          <div className="flex h-11 shrink-0 items-center justify-end px-4">
            <Button size="sm" variant="outline" onPress={sendToWidget}>
              <PanelRight size={13} />
              Send to the panel
            </Button>
          </div>
        ) : null}
        <NexoConversation variant="page" />
      </div>
    </div>
  );
}
