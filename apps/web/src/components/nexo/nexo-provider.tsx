"use client";

/**
 * Nexo's state, once, above both of its windows.
 *
 * There is one live conversation at a time and two ways to look at it: the
 * launcher's floating panel, and the Nexo section's full page. Switching
 * between them is not a hand-off of data — they are the same session, so a
 * turn started in the corner while reading a node is still there, mid-stream,
 * when you open the page, and a conversation picked from the page's history
 * follows you back to the corner when you go back to work.
 *
 * That is why this provider sits in the workspace shell rather than in either
 * surface: only the shell outlives both.
 *
 * It stays deliberately light on imports — the shell is on a gzip budget, so
 * the markdown/streaming stack lives in the panel, loaded on first open.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import type { SelectionContext } from "@bcontext-dev/contract/nexo/assistant";
import { nexoPath } from "@/lib/view-shell";
import { workspaceApiRef, workspacePath } from "@/web/workspace-url";
import { useWorkspace } from "../workspace-context";
import { NexoContext, useNexoSession, type NexoCtx } from "./nexo-session";

export { useNexo, type ConversationSummary, type NexoMessage } from "./nexo-session";

const WIDTH_KEY = "bcontext:nexo-width";
const MIN_WIDTH = 340;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 420;

export function NexoProvider({ children }: { children: React.ReactNode }) {
  const { address, activeViewSlug, inspectedNodeId, activeNodeId } = useWorkspace();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [width, setWidthState] = useState(DEFAULT_WIDTH);
  const [selection, setSelection] = useState<SelectionContext | null>(null);
  const wsRef = workspaceApiRef(address);

  // The general Nexo's page is the Chat tab of `/nexos/general`; a turn sent
  // from there while the panel is closed comes from the page.
  const onNexoPage = activeViewSlug === "nexos";
  const surface = useCallback(
    () => (onNexoPage && !open ? ("page" as const) : ("widget" as const)),
    [onNexoPage, open],
  );
  const clearSelection = useCallback(() => setSelection(null), []);

  const session = useNexoSession({
    chatUrl: "/api/nexo",
    listUrl: `/api/nexo/conversations?workspace=${encodeURIComponent(wsRef)}`,
    surface,
    selection,
    onSelectionConsumed: clearSelection,
  });

  // -- Persisted width -------------------------------------------------------

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(WIDTH_KEY);
      const px = raw ? Number.parseInt(raw, 10) : NaN;
      if (Number.isFinite(px)) setWidthState(clampWidth(px));
    } catch {
      // Private mode, blocked storage: the default width is fine.
    }
  }, []);

  const setWidth = useCallback((px: number) => {
    const next = clampWidth(px);
    setWidthState(next);
    try {
      window.localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      // Not worth telling anyone about.
    }
  }, []);

  // -- Selection -------------------------------------------------------------
  //
  // The editor tells us what the user highlighted, with the node and block it
  // came from. That pair is what turns "rewrite this" into an exact edit.

  useEffect(() => {
    const onSelect = (event: Event) => {
      const detail = (event as CustomEvent).detail as SelectionContext | undefined;
      if (!detail?.text) return;
      setSelection(detail);
      setOpen(true);
    };
    window.addEventListener("bcontext:nexo-selection", onSelect);
    return () => window.removeEventListener("bcontext:nexo-selection", onSelect);
  }, []);

  // A selection stops being true the moment the user opens something else.
  useEffect(() => {
    setSelection((current) =>
      current && current.node_id && current.node_id !== (inspectedNodeId ?? activeNodeId)
        ? null
        : current,
    );
  }, [inspectedNodeId, activeNodeId]);

  // ⌘J / Ctrl+J toggles Nexo from anywhere (the launcher's tooltip and the
  // command palette's empty state both name the key).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "j") return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // -- Moving between the two windows ---------------------------------------

  /**
   * Take the conversation back to work: the panel opens and the page steps
   * aside, to wherever the user came from — or the dashboard, when they
   * arrived at Nexo directly and there is nothing to go back to.
   */
  const sendToWidget = useCallback(() => {
    setOpen(true);
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push(workspacePath(address) as Route);
  }, [address, router]);

  const { conversationId } = session;
  const openInPage = useCallback(() => {
    setOpen(false);
    router.push(nexoPath(address, conversationId ?? undefined) as Route);
  }, [address, conversationId, router]);

  const value = useMemo<NexoCtx>(
    () => ({
      ...session,
      open,
      openNexo: () => setOpen(true),
      closeNexo: () => setOpen(false),
      toggleNexo: () => setOpen((v) => !v),
      width,
      setWidth,
      sendToWidget,
      openInPage,
      selection,
      clearSelection,
      persona: null,
    }),
    [clearSelection, open, openInPage, selection, sendToWidget, session, setWidth, width],
  );

  return <NexoContext.Provider value={value}>{children}</NexoContext.Provider>;
}

function clampWidth(px: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px));
}
