"use client";

/**
 * The way in: Nexo itself, bottom-right of whatever you are looking at.
 *
 * The button is the avatar — no chrome around it, because a circle inside a
 * circle is one circle too many. It keeps working while closed, and says so:
 * the eyes glance around whenever a turn is running, which is how you know the
 * answer you walked away from is still coming.
 *
 * It stays cheap on purpose. The panel and everything it drags in (markdown,
 * streaming, the chat kit in `ui/chat`) only load once someone opens it.
 *
 * It is not there on a Nexo's own page (`nexos/<nexo>`): that page has the
 * conversation as a tab, and a bubble in the corner sat on its Send button
 * and its last switches. Toasts stack above it (`data-nexo-launcher`, read by
 * `toast.tsx`), never under it.
 *
 * Being on every workspace page also makes it the place that finishes a
 * native OAuth hop started from a Nexo's Sources: the callback lands on the
 * app root, and this sends the person back to that Nexo
 * (`lib/nexos/connect-return.ts`).
 */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import { takeConnectReturn } from "@/lib/nexos/connect-return";
import { cn } from "@bcontext-dev/contract/utils";
import { gradientFor } from "@bcontext-dev/contract/workspace-gradients";
import { useWorkspace } from "../workspace-context";
import { NexoAvatar } from "./nexo-avatar";
import { useNexo } from "./nexo-provider";

const NexoPanel = dynamic(() => import("./nexo-panel").then((m) => m.NexoPanel));

export function NexoLauncher() {
  const { open, toggleNexo, loading } = useNexo();
  const { workspace, workspaceSlug } = useWorkspace();
  const pathname = usePathname() ?? "";
  const router = useRouter();
  // The workspace's own two colours, the same pair as the tile in the
  // top-left: at 44px the face is a logo, and a logo takes the identity.
  const gradient = gradientFor({
    slug: workspaceSlug,
    metadata: workspace?.metadata ?? null,
  });
  // Once opened, the panel stays mounted so a stream survives closing the
  // window — you can put Nexo away mid-answer and come back to it finished.
  const [everOpened, setEverOpened] = useState(false);

  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  useEffect(() => {
    const back = takeConnectReturn();
    if (back && back.split("?")[0] !== pathname) router.replace(back as Route);
    // Once per arrival in the workspace; the note is gone after the first read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (/\/nexos\/[^/]+/.test(pathname)) return null;

  return (
    <>
      <button
        type="button"
        onClick={toggleNexo}
        aria-label={open ? "Close Nexo" : "Ask Nexo"}
        aria-expanded={open}
        title="Nexo · ⌘J"
        data-nexo-launcher
        className={cn(
          "absolute bottom-3 right-3 z-40 rounded-full leading-none transition-[transform,opacity] duration-200 ease-out",
          "hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          open ? "pointer-events-none scale-90 opacity-0" : "scale-100 opacity-100",
        )}
      >
        <NexoAvatar
          size={44}
          mood={loading ? "thinking" : "idle"}
          tracksCursor
          gradient={gradient}
          className="nexo-avatar--floating"
        />
      </button>
      {everOpened ? <NexoPanel /> : null}
    </>
  );
}
