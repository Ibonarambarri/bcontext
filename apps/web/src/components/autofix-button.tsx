"use client";

/**
 * The Autofix trigger in the node page header (`n/[nodeId]/page.tsx`). It
 * has no access to the editor instance, so it fires a window event that
 * `editor.tsx` listens for; the slash menu's "Autofix" item fires the same
 * one. The editor owns the body, the request and the review diff.
 */
import { Wand2 } from "lucide-react";
import { Button } from "@heroui/react";

/** Fires the editor's autofix flow (the editor owns the node body). */
export function AutofixButton() {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label="Autofix — restructure this note with AI, review before applying"
      onPress={() => window.dispatchEvent(new CustomEvent("bcontext:autofix"))}
      className="mono h-auto gap-1.5 rounded-md border-[var(--line)] px-2.5 py-1 text-[9.5px] uppercase tracking-[0.12em] text-[var(--ink-3)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
      render={(props) => (
        <button
          {...props}
          title="Autofix — restructure this note with AI, review before applying"
        />
      )}
    >
      <Wand2 size={11} />
      Autofix
    </Button>
  );
}
