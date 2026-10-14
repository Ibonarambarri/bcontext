/**
 * Integrations hub + NEXO conflicts — a local mirror of the API's shapes
 * (`/api/integrations/*`, `/api/connectors/*`, `/api/nexo/conflicts`). The
 * vendored `@bcontext-dev/contract` does not carry them yet; when it does,
 * import from there and delete this copy rather than letting the two drift.
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

export type IntegrationVia = "native" | "nango";

/**
 * What a workspace needs to register its OWN OAuth app for a Nango-backed
 * provider (hybrid OAuth): the callback Nango answers on,
 * the scopes the app must allow, and the developer console when known.
 */
export interface IntegrationOAuthSetup {
  callback_url: string;
  scopes: string[];
  console_url?: string | null;
  auth_mode: "oauth2" | "oauth1" | "oauth2_cc";
}

/** Which OAuth app an install authorises through. Missing on old installs = shared. */
export type IntegrationOAuthApp = "shared" | "own";

export interface IntegrationCatalogEntry {
  /** connector_id, e.g. "slack", "jira", "airtable". */
  key: string;
  name: string;
  category: IntegrationCategory;
  /** 1 = most popular; sort ascending. */
  popularity: number;
  via: IntegrationVia;
  auth: "oauth2" | "api_key" | "basic" | "app" | "none";
  logo_url: string | null;
  nango_provider?: string;
  /** One line: what NEXO can learn from it. */
  description: string;
  status: "available" | "coming_soon";
  /**
   * `ready`: Bcontext's shared OAuth app exists for this provider, so a
   * person only authorises. `needs_oauth_app`: no shared app — the
   * workspace connects with its own OAuth app (client id + secret pasted in
   * the connect flow, stored only in Nango). Absent → connectable as-is.
   */
  setup?: "ready" | "needs_oauth_app";
  /** Present for every OAuth Nango-backed entry. */
  oauth_setup?: IntegrationOAuthSetup;
}

/** Credentials of a workspace's own OAuth app, sent once and never echoed back. */
export interface OwnOAuthAppInput {
  client_id: string;
  client_secret: string;
  scopes?: string[];
}

export type IntegrationActivityState = "idle" | "fetching" | "processing" | "error";

/** Live queue state of one install, as the hub's activity strip shows it. */
export interface IntegrationActivity {
  connector_id: string;
  install_id: string;
  state: IntegrationActivityState;
  running_jobs: number;
  queued_jobs: number;
  last_run_at: string | null;
  next_run_at: string | null;
  signals_today: number;
  candidates_today: number;
}

/**
 * How far an install's bot can search. Only Slack installs carry it today:
 * the install becomes a principal with a read grant an admin can narrow.
 * `unscoped` = installed before principals existed (searches as the
 * system); `unavailable` = the principal could not be resolved.
 */
export type ConnectorInstallReach = "all" | "narrowed" | "revoked" | "unscoped" | "unavailable";

export interface ConnectorInstallAccess {
  reach: ConnectorInstallReach;
  principal?: { id: string; kind: string } | null;
  /** One sentence, written by the API, that says what the bot can see. */
  note: string;
}

export interface ConnectorInstall {
  id: string;
  connector_id: string;
  status: string;
  config: Record<string, unknown>;
  last_sync_at?: string | null;
  last_error?: string | null;
  /** Present on Slack installs (`GET /api/connectors`). */
  access?: ConnectorInstallAccess | null;
}

/** What `POST /api/connectors/:id/install` answers. */
export interface InstallResponse {
  install?: ConnectorInstall;
  /** Native OAuth connectors: where to send the browser (API sends snake_case). */
  redirect_url?: string | null;
  redirectUrl?: string;
  /** Nango-backed connectors: a Connect UI session. */
  connect?: { session_token: string; connect_url?: string };
  error?: string;
  message?: string;
  /** With `409 needs_oauth_app`: what the own-app form has to show. */
  oauth_setup?: IntegrationOAuthSetup;
  /** Slack: what the bot can search once installed. */
  access?: ConnectorInstallAccess | null;
}

export type NexoConflictKind = "contradiction" | "doubt" | "stale";
export type NexoConflictStatus = "open" | "resolved" | "dismissed";

export interface NexoConflictEvidence {
  source: string;
  external_id?: string;
  url?: string;
  /** Exact quote. */
  excerpt: string;
  at?: string;
}

export interface NexoConflictResolution {
  summary: string;
  actions: Array<{ op: string; node_id?: string; title?: string }>;
}

/** A contradiction/doubt/stale finding NEXO raised from ingested signals, with its evidence. */
export interface NexoConflict {
  id: string;
  workspace_id: string;
  kind: NexoConflictKind;
  summary: string;
  context_md: string;
  evidence: NexoConflictEvidence[];
  related_node_ids: string[];
  candidate_id: string | null;
  status: NexoConflictStatus;
  decision_text: string | null;
  resolution: NexoConflictResolution | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface RelatedNodeSummary {
  id: string;
  title: string;
  kind: string;
}

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
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

export const CONFLICT_KIND_LABELS: Record<NexoConflictKind, string> = {
  contradiction: "Contradiction",
  doubt: "Doubt",
  stale: "Stale",
};
