/**
 * Where the product lives, for links that leave the server (invitations,
 * auth redirects, emails). Always the PRODUCT web app, never a marketing
 * site: only the app has /invite and /auth/confirm to land on.
 *
 * Read at call time like the rest of `@/lib/env`. Outside production an
 * unset `APP_URL` means the local web (`http://localhost:3000`); in
 * production there is no sensible default — a link to someone else's host
 * would be worse than none — so the API and the worker refuse to boot
 * without it (`assertAppUrlConfigured`), and `appBaseUrl` throws if it is
 * ever reached anyway.
 */
import { appUrl as configuredAppUrl } from "@/lib/env";

const DEV_APP_URL = "http://localhost:3000";

function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production";
}

/** `APP_URL` without a trailing slash; the local web outside production. */
export function appBaseUrl(): string {
  const raw = configuredAppUrl() || "";
  if (raw) return raw.replace(/\/+$/, "");
  if (isProduction()) throw new Error("APP_URL is not set");
  return DEV_APP_URL;
}

/**
 * Boot check for the processes that build links (API, worker). Throws in
 * production when `APP_URL` is missing so the supervisor shows a failed
 * deploy instead of a server that mails broken invitations.
 */
export function assertAppUrlConfigured(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProduction(env)) return;
  const raw = env.APP_URL ?? env.NEXT_PUBLIC_APP_URL ?? env.NEXT_PUBLIC_SITE_URL;
  if (!raw) {
    throw new Error("APP_URL is required in production: set it to the public URL of the web app");
  }
}

/** The public link an invitation travels as. */
export function inviteUrl(token: string): string {
  return `${appBaseUrl()}/invite/${token}`;
}
