/**
 * GitHub (via Nango) — `github-nango` → Nango `github` (OAuth2 user token;
 * proxy base https://api.github.com).
 *
 * The Nango-backed twin of the native `github` connector (GitHub App with
 * webhooks). Same "issues and pull requests updated since the cursor"
 * reader as `github-pat`, authenticated with the OAuth token Nango holds.
 * Native keeps the real-time events; this one gives homogeneous auth and
 * the cadence-driven daily batch.
 */
import { createGithubAdapter } from "./github-pat";

export const githubNangoAdapter = createGithubAdapter({ id: "github-nango", provider: "github" });
