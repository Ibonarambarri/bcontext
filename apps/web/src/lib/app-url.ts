/**
 * The origin this instance is served from, for client components that build
 * absolute URLs (MCP endpoints, copyable snippets).
 *
 * In the browser it is the address bar's origin, which is what the person
 * will paste into an agent config. During server rendering there is no
 * window, so it is `NEXT_PUBLIC_APP_URL` when set and the empty string
 * otherwise (a relative URL until hydration fills in the real one). No
 * domain is baked in: every self-hosted instance answers on its own.
 */
export function appUrl(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
}
