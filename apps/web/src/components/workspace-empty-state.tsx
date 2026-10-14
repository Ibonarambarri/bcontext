"use client";

/**
 * Empty workspace — first-content seeder, shown by the workspace home
 * (`/w/<org>/<ws>/page.tsx`) when the workspace has no nodes.
 *
 * EmptyState (outline variant: dashed border, icon media) with a
 * grid of seed cards. Each seed creates a real node through the workspace
 * context's `createNode` with the kind's template body, so the first node is
 * a normal node and opens as one; the ⌘K hint dispatches the palette's own
 * shortcut rather than duplicating its wiring.
 */

import { useState } from "react";
import {
  Bug,
  CheckSquare,
  FileText,
  GitBranch,
  LayoutGrid,
  Loader2,
  Quote,
  Wand2,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button, Kbd } from "@heroui/react";
import type { NodeKind } from "@bcontext-dev/contract/types";
import { templateFor } from "@/lib/templates";
import { useWorkspace } from "./workspace-context";

interface Seed {
  kind: NodeKind;
  title: string;
  meta: string;
  draftTitle: string;
  Icon: typeof FileText;
}

const SEEDS: Seed[] = [
  {
    kind: "task",
    title: "First task",
    meta: "P0 · onboarding bootstrap",
    draftTitle: "Onboarding bootstrap",
    Icon: CheckSquare,
  },
  {
    kind: "decision",
    title: "First ADR",
    meta: "why bcontext?",
    draftTitle: "ADR-001: Why bcontext",
    Icon: GitBranch,
  },
  {
    kind: "skill",
    title: "First runbook",
    meta: "incident response",
    draftTitle: "Incident response runbook",
    Icon: Wand2,
  },
  {
    kind: "doc",
    title: "Strategy doc",
    meta: "north-star metric",
    draftTitle: "North-star metric",
    Icon: FileText,
  },
  {
    kind: "meeting",
    title: "Weekly note",
    meta: "recurring template",
    draftTitle: `Weekly · ${new Date().toISOString().slice(0, 10)}`,
    Icon: Quote,
  },
  {
    kind: "bug",
    title: "Bug ticket",
    meta: "with severity",
    draftTitle: "Untitled bug",
    Icon: Bug,
  },
];

export function WorkspaceEmptyState() {
  const { createNode } = useWorkspace();
  const [busyKind, setBusyKind] = useState<NodeKind | null>(null);

  async function seed(s: Seed) {
    if (busyKind) return;
    setBusyKind(s.kind);
    try {
      await createNode({
        kind: s.kind,
        title: s.draftTitle,
        content_md: templateFor(s.kind),
      });
    } finally {
      setBusyKind(null);
    }
  }

  function openCmd() {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
  }

  return (
    <EmptyState className="mt-4 min-h-[420px] rounded-2xl border border-dashed border-[var(--line)] bg-[var(--paper-2)] px-6 py-12">
      <EmptyState.Header>
        <EmptyState.Media variant="icon">
          <LayoutGrid size={18} />
        </EmptyState.Media>
        <EmptyState.Title className="serif-able text-[20px] text-[var(--ink)]">
          An empty workspace
        </EmptyState.Title>
        <EmptyState.Description className="max-w-[430px]">
          Start from one of these, or paste in a Markdown file.
        </EmptyState.Description>
      </EmptyState.Header>
      <EmptyState.Content className="w-full max-w-[560px] flex-col items-center gap-4">
        <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3">
          {SEEDS.map((s) => {
            const Icon = s.Icon;
            const busy = busyKind === s.kind;
            return (
              <Button
                key={s.title}
                variant="outline"
                onPress={() => void seed(s)}
                isDisabled={!!busyKind}
                className="h-auto w-full min-w-0 flex-col items-start gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3.5 py-3 text-left font-normal hover:border-[var(--ink-mute)]"
              >
                <span className="text-[var(--ink)]">
                  {busy ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Icon size={14} />
                  )}
                </span>
                <span className="block w-full truncate text-[12.5px] text-[var(--ink)]">{s.title}</span>
                <span className="mono block w-full truncate text-[10.5px] text-[var(--ink-3)]">{s.meta}</span>
              </Button>
            );
          })}
        </div>
        <div className="mono text-[11px] text-[var(--ink-mute)]">
          or press{" "}
          <button type="button" onClick={openCmd} className="cursor-default">
            <Kbd>
              <Kbd.Abbr keyValue="command" />
              <Kbd.Content>K</Kbd.Content>
            </Kbd>
          </button>
        </div>
      </EmptyState.Content>
    </EmptyState>
  );
}
