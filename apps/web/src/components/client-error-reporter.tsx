"use client";

/**
 * Mount point for the browser error reporter.
 *
 * It renders nothing and exists only because the root layout is a Server
 * Component: the listeners have to be attached from client code, once, as
 * early in the tree as possible — anything thrown before this effect runs is
 * simply not reportable, so "high in the layout" is the whole placement
 * argument.
 */
import { useEffect } from "react";
import { installClientErrorReporter } from "@/lib/client-error-reporter";

export function ClientErrorReporter(): null {
  useEffect(() => {
    installClientErrorReporter();
  }, []);
  return null;
}
