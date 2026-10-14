"use client";

/**
 * The ONE surface a selected node opens in: a floating panel over the
 * active view (`floating-panel.tsx` is the window itself; this is what the
 * node puts in it). Half of the surface by default (the view stays usable
 * next to it — the graph re-centers the node in the free half), expandable
 * to the whole surface, never a modal. Its own Back/Forward walks the trail
 * of nodes opened from links, backlinks, relations and search.
 *
 * It shares the right edge with Nexo. `--nexo-w` (set on the active-page
 * region by the shell) is Nexo's width, or `0px` when it is closed: the panel
 * offsets its right edge by it and clamps its width to what is left, so
 * opening Nexo slides the node aside — including in "full", which means
 * everything Nexo is not using rather than literally everything.
 *
 * On the Nexo page the panel is always the half: Nexo opens nodes to talk
 * about them, and a full-size node would cover the conversation it belongs
 * to. "Open as page" is the way to read one on its own from there.
 *
 * Keys: Esc closes (handled by the shared panel) · Alt+← / Alt+→ walk the
 * trail.
 */

import { useEffect } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { FloatingPanel, FloatingPanelAction } from "./floating-panel";
import { NodeInspectorSurface } from "./node-inspector";
import { useWorkspace } from "./workspace-context";

export function NodeFloatingPanel() {
  const {
    inspectedNodeId,
    inspectedBlockId,
    activeNodeId,
    closeNode,
    goBackNode,
    goForwardNode,
    canGoBackNode,
    canGoForwardNode,
    nodePanelSize,
    setNodePanelSize,
    openNodePage,
    activeViewSlug,
  } = useWorkspace();
  const isMobile = useIsMobile();
  // The `/n/<id>` route is the node itself — nothing to float over it.
  const open = Boolean(inspectedNodeId) && !activeNodeId;
  const halfOnly = activeViewSlug === "nexo";
  const full = isMobile || (nodePanelSize === "full" && !halfOnly);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.key === "ArrowLeft" && canGoBackNode) {
        event.preventDefault();
        goBackNode();
      } else if (event.altKey && event.key === "ArrowRight" && canGoForwardNode) {
        event.preventDefault();
        goForwardNode();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, goBackNode, goForwardNode, canGoBackNode, canGoForwardNode]);

  const toolbar = (
    <div className="flex items-center gap-0.5">
      <FloatingPanelAction label="Back" disabled={!canGoBackNode} onPress={goBackNode}><ArrowLeft size={13} /></FloatingPanelAction>
      <FloatingPanelAction label="Forward" disabled={!canGoForwardNode} onPress={goForwardNode}><ArrowRight size={13} /></FloatingPanelAction>
      <span className="mx-0.5 h-4 w-px bg-[var(--line)]" />
      {!isMobile && !halfOnly ? (
        <FloatingPanelAction label={full ? "Shrink to half" : "Expand"} onPress={() => setNodePanelSize(full ? "half" : "full")}>
          {full ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </FloatingPanelAction>
      ) : null}
      <FloatingPanelAction label="Open as page" onPress={() => openNodePage()}><ExternalLink size={13} /></FloatingPanelAction>
      <FloatingPanelAction label="Close" onPress={closeNode}><X size={13} /></FloatingPanelAction>
    </div>
  );

  // z-30: above the conflict panel (z-20), so a node opened from inside a
  // conflict covers it and closing the node returns to the conflict.
  return (
    <FloatingPanel open={open} size={full ? "full" : "half"} label="Node" onClose={closeNode} data-node-panel className="z-30">
      {open && inspectedNodeId ? (
        <NodeInspectorSurface nodeId={inspectedNodeId} blockId={inspectedBlockId} toolbar={toolbar} onClose={closeNode} />
      ) : null}
    </FloatingPanel>
  );
}
