"use client";

/**
 * A specialist Nexo's conversation, offered to the chat components as if it
 * were the only Nexo there is.
 *
 * `NexoPage`, `NexoConversation` and `NexoHistory` read `useNexo()`; inside
 * this provider that answers with a session against
 * `/api/nexos/:id/chat` (same NDJSON wire as `/api/nexo`) and the Nexo's own
 * history, so the general Nexo's chat is reused unchanged for every
 * specialist. Mounted by the Chat tab of `nexo-detail.tsx`.
 *
 * There is no floating panel for a specialist: the panel controls are inert
 * and `sendToWidget` is null, which hides the button. The general Nexo's
 * panel is closed on mount so two Nexos never talk over each other on the
 * same screen.
 */
import { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { nexoChatUrls } from "@/lib/nexos/api";
import { useWorkspace } from "../workspace-context";
import { NexoContext, useNexoSession, type NexoCtx } from "../nexo/nexo-session";

const noop = () => {};

export function NexoScopeProvider({
  nexo,
  children,
}: {
  nexo: { id: string; name: string };
  children: React.ReactNode;
}) {
  const { address } = useWorkspace();
  const outer = useContext(NexoContext);
  const urls = useMemo(() => nexoChatUrls(address, nexo.id), [address, nexo.id]);
  const surface = useCallback(() => "page" as const, []);

  const session = useNexoSession({
    chatUrl: urls.chat,
    listUrl: urls.sessions,
    surface,
    selection: null,
    onSelectionConsumed: noop,
  });

  // Once, on arrival: ⌘J may still open the general panel afterwards.
  const outerRef = useRef(outer);
  useEffect(() => {
    outerRef.current?.closeNexo();
  }, []);

  const value = useMemo<NexoCtx>(
    () => ({
      ...session,
      open: false,
      openNexo: noop,
      closeNexo: noop,
      toggleNexo: noop,
      width: 0,
      setWidth: noop,
      sendToWidget: null,
      openInPage: noop,
      selection: null,
      clearSelection: noop,
      persona: { id: nexo.id, name: nexo.name },
    }),
    [nexo.id, nexo.name, session],
  );

  return <NexoContext.Provider value={value}>{children}</NexoContext.Provider>;
}
