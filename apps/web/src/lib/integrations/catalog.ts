/**
 * The integrations marketplace's static side: the native connectors the web
 * can always show, the tab list, and the pure helpers the hub uses to decide
 * how a catalog entry connects (shared OAuth app vs. the workspace's own) and
 * to filter what the person sees. The live catalog comes from the API
 * (`GET /api/integrations/catalog`); this file is what it falls back to.
 */
import type { IntegrationCatalogEntry, IntegrationCategory, IntegrationOAuthApp, IntegrationOAuthSetup } from "./types";
import { publicEnv } from "@/lib/public-env";

/**
 * The five connectors the web already knows how to drive. They are the
 * fallback when `GET /api/integrations/catalog` is not reachable (older
 * API), so the marketplace is never an empty box.
 */
export const NATIVE_CATALOG: IntegrationCatalogEntry[] = [
  {
    key: "meeting-bot",
    name: "Meeting records",
    category: "meetings",
    popularity: 1,
    via: "native",
    auth: "none",
    logo_url: null,
    description: "A bot joins your calls; decisions and tasks come out of the transcript.",
    status: "available",
  },
  {
    key: "slack",
    name: "Slack",
    category: "communication",
    popularity: 2,
    via: "native",
    auth: "oauth2",
    logo_url: "https://app.nango.dev/images/template-logos/slack.svg",
    description: "Threads in allow-listed channels become decisions and docs.",
    status: "available",
  },
  {
    key: "github",
    name: "GitHub",
    category: "dev-tools",
    popularity: 3,
    via: "native",
    auth: "app",
    logo_url: "https://app.nango.dev/images/template-logos/github.svg",
    description: "Merged PRs and issues feed technical decisions and tasks.",
    status: "available",
  },
  {
    key: "linear",
    name: "Linear",
    category: "project-management",
    popularity: 4,
    via: "native",
    auth: "oauth2",
    logo_url: "https://app.nango.dev/images/template-logos/linear.svg",
    description: "Issues sync both ways as tasks.",
    status: "available",
  },
  {
    key: "notion",
    name: "Notion",
    category: "docs-knowledge",
    popularity: 5,
    via: "native",
    auth: "oauth2",
    logo_url: "https://app.nango.dev/images/template-logos/notion.svg",
    description: "Pages import once as docs with provenance.",
    status: "available",
  },
];

/** Tabs of the marketplace, in display order. */
export const MARKETPLACE_TABS: Array<{ id: "all" | "popular" | IntegrationCategory; label: string }> = [
  { id: "popular", label: "Popular" },
  { id: "all", label: "All" },
  { id: "communication", label: "Communication" },
  { id: "project-management", label: "Project mgmt" },
  { id: "docs-knowledge", label: "Docs" },
  { id: "dev-tools", label: "Dev tools" },
  { id: "crm-sales", label: "CRM" },
  { id: "support", label: "Support" },
  { id: "meetings", label: "Meetings" },
  { id: "storage", label: "Storage" },
  { id: "automation", label: "Automation" },
  { id: "data-analytics", label: "Data" },
];

const POPULAR_THRESHOLD = 20;

/**
 * True when the workspace has to bring its own OAuth app to connect this
 * entry: it is live, but Bcontext has no shared OAuth app for it. The
 * marketplace shows a "Your own app" chip and Connect opens the OAuth app
 * form instead of a Connect UI that would fail on the Nango side.
 */
export function needsOwnApp(entry: Pick<IntegrationCatalogEntry, "status" | "setup">): boolean {
  return entry.status === "available" && entry.setup === "needs_oauth_app";
}

/**
 * True when the entry is an OAuth provider through Nango, i.e. a workspace
 * MAY connect it with its own OAuth app even if a shared one exists.
 */
export function canUseOwnApp(
  entry: Pick<IntegrationCatalogEntry, "status" | "via" | "oauth_setup">,
): entry is Pick<IntegrationCatalogEntry, "status" | "via" | "oauth_setup"> & { oauth_setup: IntegrationOAuthSetup } {
  return entry.status === "available" && entry.via === "nango" && Boolean(entry.oauth_setup);
}

/** The OAuth app an install authorises through; installs from before the hybrid model are shared. */
export function installOAuthApp(config: Record<string, unknown> | undefined): IntegrationOAuthApp {
  return config?.oauth_app === "own" ? "own" : "shared";
}

/**
 * The callback URL the person registers in the provider console — Nango's,
 * never Bcontext's. The API's answer wins; without it, the configured Nango
 * host's; with neither (an instance without Nango) there is none to show.
 */
export function oauthCallbackUrl(setup: Pick<IntegrationOAuthSetup, "callback_url"> | null | undefined): string {
  const url = setup?.callback_url?.trim();
  if (url && url.length > 0) return url;
  const host = publicEnv().nangoHost;
  return host ? `${host.replace(/\/+$/, "")}/oauth/callback` : "";
}

/** Scopes as the provider consoles expect them pasted: one per line, deduped, no blanks. */
export function formatScopes(scopes: readonly string[] | null | undefined): string {
  return uniqueScopes(scopes).join("\n");
}

/** Scopes split on whitespace/commas and deduped, order preserved. */
export function uniqueScopes(scopes: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of scopes ?? []) {
    for (const piece of raw.split(/[\s,]+/)) {
      const scope = piece.trim();
      if (scope && !out.includes(scope)) out.push(scope);
    }
  }
  return out;
}

/** Tab + search filter for the marketplace grid; available entries always sort first. */
export function filterCatalog(
  entries: IntegrationCatalogEntry[],
  tab: (typeof MARKETPLACE_TABS)[number]["id"],
  query: string,
): IntegrationCatalogEntry[] {
  const q = query.trim().toLowerCase();
  return entries
    .filter((entry) => {
      if (tab === "popular") return entry.popularity <= POPULAR_THRESHOLD;
      if (tab === "all") return true;
      return entry.category === tab;
    })
    .filter((entry) => {
      if (!q) return true;
      return (
        entry.name.toLowerCase().includes(q) ||
        entry.key.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      // Available first, then by popularity, then name.
      if (a.status !== b.status) return a.status === "available" ? -1 : 1;
      if (a.popularity !== b.popularity) return a.popularity - b.popularity;
      return a.name.localeCompare(b.name);
    });
}
