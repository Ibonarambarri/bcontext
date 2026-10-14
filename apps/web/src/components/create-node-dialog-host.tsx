"use client";

/**
 * Mount point for the global "create node" dialog. Lives in
 * workspace-shell.tsx next to <CommandPalette /> so it is always mounted
 * while a workspace is open, and keeps the dialog's chunk out of the shell
 * until it is first opened.
 *
 * Two open triggers, both on `window` so no caller needs a prop or a ref:
 *   - the `bcontext:new-node` custom event (the sidebar's "New" button
 *     dispatches it; any other button that wants the dialog can too);
 *   - ⌘⇧K / Ctrl+Shift+K, which toggles it. ⌘N is taken by the browser and
 *     ⌘J belongs to Nexo (the launcher and the palette both advertise it),
 *     so the create shortcut is the shifted sibling of ⌘K: ⌘K finds a
 *     node, ⌘⇧K makes one — the same ⌘⇧-letter shape as ⌘⇧M (record).
 */
import { useEffect, useState } from "react";
import { CreateNodeDialog } from "./create-node-dialog";
import { type WorkspaceAddress } from "@/web/workspace-url";

export function CreateNodeDialogHost({ workspace }: { workspace: WorkspaceAddress }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onTrigger() {
      setOpen(true);
    }
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener("bcontext:new-node", onTrigger);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("bcontext:new-node", onTrigger);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <CreateNodeDialog
      open={open}
      onClose={() => setOpen(false)}
      workspace={workspace}
    />
  );
}
