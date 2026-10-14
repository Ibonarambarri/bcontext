"use client";

/**
 * Global keyboard shortcut: ⌘⇧M opens the record-meeting modal anywhere
 * in the workspace shell — the command-palette equivalent for the bot.
 * Lives next to <CommandPalette /> in workspace-shell.tsx.
 *
 * Why not inside CommandPalette: the palette is a node-jump UI today
 * (modes: jump / search / tag). Bolting a fourth "actions" mode in is a
 * refactor for a single entry; a dedicated shortcut keeps surface area
 * small and lets agents bind their own modal triggers the same way.
 */
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { type WorkspaceAddress } from "@/web/workspace-url";

// Loaded on first ⌘⇧M — the modal (Stepper, realtime hooks) has no business
// in the shell's first-load chunk group for a rarely-used shortcut.
const RecordMeetingModal = dynamic(() =>
  import("./record-meeting-modal").then((m) => m.RecordMeetingModal),
);

export function RecordMeetingShortcut({ workspace }: { workspace: WorkspaceAddress }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!mounted) return null;
  return (
    <RecordMeetingModal
      open={open}
      onClose={() => setOpen(false)}
      workspace={workspace}
    />
  );
}
