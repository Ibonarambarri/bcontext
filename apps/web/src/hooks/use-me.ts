"use client";

import { useCallback, useEffect, useState } from "react";
import type { Me } from "@bcontext-dev/contract/me";

/**
 * Who the person is, on the client, read once and shared.
 *
 * Three places want the same answer at the same time — the sidebar footer, the
 * hub's top bar, the profile dialog — and each of them mounting its own fetch
 * meant three requests for one fact and, worse, three copies of it that drift
 * the moment somebody changes their name. So the answer lives in this module:
 * one in-flight request, one cached value, and an event that tells every
 * mounted consumer to re-render when it changes.
 *
 * A failed read is a `null` rather than an exception. Not being signed in is a
 * normal state for these components (the hub redirects on its own), and an
 * avatar is not worth an error boundary.
 */

let cached: Me | null = null;
let inFlight: Promise<Me | null> | null = null;

const EVENT = "bcontext:me-changed";

async function read(): Promise<Me | null> {
  try {
    const res = await fetch("/api/me", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as Me;
  } catch {
    return null;
  }
}

/** The cached answer, fetching it once if nobody has yet. */
function loadMe(): Promise<Me | null> {
  if (cached) return Promise.resolve(cached);
  inFlight ??= read().then((me) => {
    inFlight = null;
    if (me) publishMe(me);
    return me;
  });
  return inFlight;
}

/**
 * Replace the cached person and tell everyone. Called by whatever just wrote
 * (the profile dialog), so a rename lands in the sidebar without a reload.
 */
export function publishMe(me: Me): void {
  cached = me;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT));
  }
}

/** Forget the cached person — sign-out, so the next mount asks again. */
export function forgetMe(): void {
  cached = null;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT));
  }
}

/**
 * The signed-in person for a client component. `loading` is true only until
 * the shared read settles; `reload` drops the cache and asks the API again.
 */
export function useMe(): { me: Me | null; loading: boolean; reload: () => void } {

  const [me, setMe] = useState<Me | null>(cached);
  const [loading, setLoading] = useState(cached === null);

  const reload = useCallback(() => {
    cached = null;
    setLoading(true);
    void loadMe().then((next) => {
      setMe(next);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void loadMe().then((next) => {
      if (!alive) return;
      setMe(next);
      setLoading(false);
    });
    const onChange = () => {
      if (alive) setMe(cached);
    };
    window.addEventListener(EVENT, onChange);
    return () => {
      alive = false;
      window.removeEventListener(EVENT, onChange);
    };
  }, []);

  return { me, loading, reload };
}
