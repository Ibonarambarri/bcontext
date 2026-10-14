"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { Onboarding, OnboardingDismissal } from "@bcontext-dev/contract/onboarding";
import type { WorkspaceAddress } from "@/web/workspace-url";
import { workspaceApiRef } from "@/web/workspace-url";

/**
 * The "Getting started" checklist of a workspace, for the person signed in.
 *
 * Read from `GET /api/onboarding` on mount, on every route change inside
 * the workspace, whenever the tab comes back into focus, and — while the
 * caller says the guide is on screen with work left — every 20 seconds.
 * The steps that matter happen elsewhere (the agent is connected from a
 * terminal, the integration from an OAuth tab) or on another page of this
 * tab (a question to Nexo), and the box has to tick itself either way
 * without the person reloading. Nothing is derived on the client — the API
 * already says which steps are done.
 *
 * `dismiss` is optimistic: the panel goes away at once and the stamp is
 * written behind it. If the write fails the panel comes back with the
 * server's answer, which is the convention for every non-destructive write.
 */
export interface OnboardingState {
  onboarding: Onboarding | null;
  /** Until the first answer; the panel shows nothing rather than a flash. */
  loading: boolean;
  refresh: () => void;
  dismiss: () => Promise<void>;
}

async function read(address: WorkspaceAddress): Promise<Onboarding | null> {
  try {
    const res = await fetch(
      `/api/onboarding?workspace=${encodeURIComponent(workspaceApiRef(address))}`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    return (await res.json()) as Onboarding;
  } catch {
    return null;
  }
}

/** How often to ask again while the guide is visible and steps are pending. */
const POLL_MS = 20_000;

export function useOnboarding(
  address: WorkspaceAddress,
  /** Is the guide on screen? Polling is pointless behind a hidden panel. */
  poll: boolean,
): OnboardingState {
  const [onboarding, setOnboarding] = useState<Onboarding | null>(null);
  const [loading, setLoading] = useState(true);
  const pathname = usePathname();
  // A late answer for a workspace the person already left must not land.
  const key = workspaceApiRef(address);
  const current = useRef(key);
  current.current = key;

  const refresh = useCallback(() => {
    const asked = key;
    void read(address).then((next) => {
      if (current.current !== asked) return;
      setOnboarding(next);
      setLoading(false);
    });
  }, [address, key]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  // A navigation inside the workspace is the moment something may just have
  // happened on the page being left (Nexo answered, an agent got added).
  // The first render is not a navigation; the mount read above covers it.
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    refresh();
  }, [pathname, refresh]);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  // Only while there is something left to tick: a finished guide has
  // nothing to learn from asking again.
  const pending = Boolean(onboarding && !onboarding.completed);
  // No visibility check here: browsers already slow timers in a hidden tab
  // to about one a minute, and a tab that is merely behind another window
  // still reports itself hidden while the person is looking at it.
  useEffect(() => {
    if (!poll || !pending) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [poll, pending, refresh]);

  const dismiss = useCallback(async () => {
    const before = onboarding;
    const optimistic = new Date().toISOString();
    setOnboarding((o) => (o ? { ...o, dismissed_at: optimistic } : o));
    try {
      const res = await fetch("/api/onboarding/dismiss", { method: "POST" });
      if (!res.ok) throw new Error(`dismiss failed: ${res.status}`);
      const { dismissed_at } = (await res.json()) as OnboardingDismissal;
      setOnboarding((o) => (o ? { ...o, dismissed_at } : o));
    } catch {
      setOnboarding(before);
    }
  }, [onboarding]);

  return { onboarding, loading, refresh, dismiss };
}
