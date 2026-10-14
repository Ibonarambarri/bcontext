"use client";

import { X } from "lucide-react";
import { Button, Tooltip } from "@heroui/react";
import { useWorkspace } from "./workspace-context";

/**
 * The `/n/<id>` route is the node as a page. Its only floating control is
 * the way back to wherever it was opened from (`return_to`, else the
 * workspace). Everything else the floating panel offers (trail, size) is
 * meaningless here — a page is a page.
 */
export function ActiveNodeInspector() {
  const { closeNode } = useWorkspace();
  return (
    <div className="fixed right-3 top-3 z-30 rounded-md border border-[var(--line)] bg-[var(--paper-2)]/95 p-0.5 shadow-md backdrop-blur [padding-top:max(2px,env(safe-area-inset-top))]">
      <Tooltip delay={400}>
        <Button isIconOnly variant="ghost" onPress={closeNode} aria-label="Back to view" className="icon-btn">
          <X size={13} />
        </Button>
        <Tooltip.Content>Back</Tooltip.Content>
      </Tooltip>
    </div>
  );
}
