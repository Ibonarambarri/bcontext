/**
 * Integration catalog — the marketplace the Integrations hub renders.
 *
 * `via` says who owns the auth + transport: `native` connectors ship their
 * own OAuth/App flow inside bcontext-api; `nango` connectors delegate auth
 * and the HTTP proxy to the self-hosted Nango instance and only carry a
 * small "what changed since cursor" adapter on our side.
 */
export type IntegrationCategory =
  | "communication"
  | "project-management"
  | "docs-knowledge"
  | "dev-tools"
  | "crm-sales"
  | "support"
  | "meetings"
  | "storage"
  | "automation"
  | "data-analytics"
  | "other";

export const INTEGRATION_CATEGORIES: readonly IntegrationCategory[] = [
  "communication",
  "project-management",
  "docs-knowledge",
  "dev-tools",
  "crm-sales",
  "support",
  "meetings",
  "storage",
  "automation",
  "data-analytics",
  "other",
] as const;

export const INTEGRATION_CATEGORY_LABEL: Record<IntegrationCategory, string> = {
  communication: "Communication",
  "project-management": "Project management",
  "docs-knowledge": "Docs & knowledge",
  "dev-tools": "Dev tools",
  "crm-sales": "CRM & sales",
  support: "Support",
  meetings: "Meetings",
  storage: "Storage",
  automation: "Automation",
  "data-analytics": "Data & analytics",
  other: "Other",
};

export type IntegrationVia = "native" | "nango";
export type IntegrationAuth = "oauth2" | "api_key" | "basic" | "app" | "none";
export type IntegrationStatus = "available" | "coming_soon";
/**
 * Whether the Nango integration behind an `available` entry is usable now.
 * OAuth providers are created in Nango with placeholder client credentials
 * until the owner registers the OAuth app and pastes the real ones in the
 * Nango dashboard: `needs_oauth_app` until then, `ready` after. Absent when
 * the API could not ask Nango (or the entry is native).
 */
export type IntegrationSetup = "ready" | "needs_oauth_app";

/**
 * What a workspace needs to register its OWN OAuth app for a provider
 * (hybrid model): Bcontext's shared app is used when the owner registered
 * one in Nango; otherwise — or when the workspace prefers — the customer
 * pastes the client id/secret of an app they created in the provider's
 * console. Present on every OAuth Nango-backed entry.
 */
export interface IntegrationOAuthSetup {
  /** Redirect URI the customer registers on the app: `<NANGO_PUBLIC_URL>/oauth/callback`. */
  callback_url: string;
  /** Default scopes the app must allow (the ones our adapter needs). */
  scopes: string[];
  /** Provider developer console, when known (Google Cloud, Entra, Slack api, …). */
  console_url?: string | null;
  auth_mode: "oauth2" | "oauth1" | "oauth2_cc";
}

export interface IntegrationCatalogEntry {
  /** connector_id, e.g. "slack", "jira", "airtable". */
  key: string;
  name: string;
  category: IntegrationCategory;
  /** 1 = most popular; sort ascending. */
  popularity: number;
  via: IntegrationVia;
  auth: IntegrationAuth;
  logo_url: string | null;
  /** Nango provider key when via === "nango" (e.g. "jira-basic"). */
  nango_provider?: string;
  /** One line: what NEXO can learn from it. */
  description: string;
  status: IntegrationStatus;
  setup?: IntegrationSetup;
  /**
   * The other way to connect the same product: a native entry points at its
   * Nango-backed twin (`slack` → `slack-nango`) and vice versa, so the hub
   * can offer "also available via Nango" / "native flow with webhooks".
   */
  alt_key?: string;
  /** Own-OAuth-app instructions; present for every OAuth Nango-backed entry. */
  oauth_setup?: IntegrationOAuthSetup;
}

/** "Popular" tab threshold: entries ranked at or above this are featured. */
export const POPULAR_RANK_MAX = 20;
