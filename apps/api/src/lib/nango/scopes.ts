/**
 * OAuth facts per Nango provider that both the sync script and the API need:
 * the default (read-only) scopes our adapters require, the auth mode Nango
 * expects for the integration credentials, and the developer console where
 * a customer creates its own OAuth app.
 *
 * Scopes are stored comma-separated on Nango (a space-separated list is
 * rejected); `defaultScopesFor` returns them as an array, `scopesForNango`
 * joins them back.
 */
import type { IntegrationOAuthSetup } from "@bcontext-dev/contract/connectors/catalog";

/** Read-only scopes per Nango provider key (see providers.yaml for the key). */
const DEFAULT_SCOPES: Record<string, string> = {
  "dropbox-sign": "basic_account_info,request_signature",
  lever: "offline_access,postings:read:admin,opportunities:read:admin",
  "google-drive": "https://www.googleapis.com/auth/drive.readonly",
  "google-mail": "https://www.googleapis.com/auth/gmail.readonly",
  "google-calendar": "https://www.googleapis.com/auth/calendar.readonly",
  "google-docs": "https://www.googleapis.com/auth/documents.readonly,https://www.googleapis.com/auth/drive.readonly",
  "google-sheet": "https://www.googleapis.com/auth/spreadsheets.readonly,https://www.googleapis.com/auth/drive.readonly",
  google: "https://www.googleapis.com/auth/drive.readonly",
  "google-meet": "https://www.googleapis.com/auth/meetings.space.readonly",
  "google-chat": "https://www.googleapis.com/auth/chat.spaces.readonly,https://www.googleapis.com/auth/chat.messages.readonly",
  "google-analytics": "https://www.googleapis.com/auth/analytics.readonly",
  asana: "default",
  hubspot: "crm.objects.deals.read,crm.objects.contacts.read,crm.objects.companies.read",
  "microsoft-teams": "offline_access,ChannelMessage.Read.All,Team.ReadBasic.All",
  outlook: "offline_access,Mail.Read",
  "one-drive": "offline_access,Files.Read.All",
  "sharepoint-online": "offline_access,Sites.Read.All",
  zoom: "recording:read,meeting:read",
  salesforce: "api,refresh_token",
  intercom: "",
  discord: "identify,guilds,messages.read",
  monday: "boards:read,updates:read",
  trello: "read",
  pipedrive: "deals:read,activities:read",
  attio: "record_permission:read,note:read",
  bitbucket: "repository,pullrequest",
  figma: "file_read",
  pagerduty: "",
  dropbox: "files.metadata.read,files.content.read",
  box: "root_readonly",
  calendly: "default",
  todoist: "data:read",
  miro: "boards:read",
  docusign: "signature",
  zapier: "zap:all,zap:runs",
  linkedin: "r_organization_social,rw_organization_admin",
  typeform: "responses:read,forms:read",
  webflow: "sites:read,cms:read",
  contentful: "content_management_read",
  shopify: "read_products,read_orders",
  quickbooks: "com.intuit.quickbooks.accounting",
  xero: "openid,profile,email,accounting.transactions.read,offline_access",
  snowflake: "refresh_token",
  "google-bigquery": "https://www.googleapis.com/auth/bigquery.readonly",
  smartsheet: "READ_SHEETS",
  basecamp: "",
  "helpscout-mailbox": "",
  youtube: "https://www.googleapis.com/auth/youtube.readonly",
  slack: "channels:read,channels:history,groups:read,groups:history,users:read,chat:write",
  github: "repo,read:org",
  linear: "read",
  notion: "",
  canva: "design:meta:read",
  servicenow: "useraccount",
  "zoho-crm": "ZohoCRM.modules.READ,ZohoCRM.settings.READ",
  wrike: "Default,wsReadOnly",
  "google-tasks": "https://www.googleapis.com/auth/tasks.readonly",
  "google-forms": "https://www.googleapis.com/auth/forms.responses.readonly,https://www.googleapis.com/auth/forms.body.readonly",
  "google-slides": "https://www.googleapis.com/auth/presentations.readonly",
  "microsoft-planner": "offline_access,Tasks.Read,Group.Read.All",
  "microsoft-word": "offline_access,Files.Read.All",
  "microsoft-excel": "offline_access,Files.Read.All",
  "microsoft-power-bi": "offline_access,Report.Read.All,Dashboard.Read.All,Dataset.Read.All",
  deel: "contracts:read,people:read",
  gusto: "",
  ramp: "transactions:read,reimbursements:read,departments:read",
  brex: "openid,offline_access,transactions.card.readonly,expenses.card.readonly",
};

/** Providers whose auth_mode in providers.yaml is OAUTH1 (the catalog says `oauth2` for both). */
const OAUTH1_PROVIDERS = new Set(["trello"]);

/**
 * Providers whose auth_mode is OAUTH2_CC (client credentials): the customer
 * enters its own client id/secret at connect time, so the shared integration
 * is created without credentials even though the catalog says `oauth2`.
 */
const OAUTH2_CC_PROVIDERS = new Set(["personio"]);

/** Developer consoles where a customer creates its own OAuth app. */
const CONSOLE_URLS: Record<string, string> = {
  google: "https://console.cloud.google.com/apis/credentials",
  microsoft: "https://entra.microsoft.com",
  atlassian: "https://developer.atlassian.com/console/myapps/",
  slack: "https://api.slack.com/apps",
  hubspot: "https://developers.hubspot.com",
  github: "https://github.com/settings/developers",
  zoom: "https://marketplace.zoom.us/develop/create",
  salesforce: "https://login.salesforce.com",
  notion: "https://www.notion.so/my-integrations",
  linear: "https://linear.app/settings/api",
  asana: "https://app.asana.com/0/my-apps",
};

/** Nango provider key → console family. */
function consoleFamily(provider: string): string | null {
  if (provider === "google" || provider.startsWith("google-") || provider === "youtube") return "google";
  if (provider === "microsoft" || provider.startsWith("microsoft-") || provider === "outlook" || provider === "one-drive" || provider === "sharepoint-online") return "microsoft";
  if (provider === "jira" || provider === "confluence" || provider.startsWith("jira-") || provider.startsWith("confluence-")) return "atlassian";
  if (provider.startsWith("salesforce")) return "salesforce";
  if (provider.startsWith("github")) return "github";
  if (CONSOLE_URLS[provider]) return provider;
  return null;
}

export function defaultScopesFor(provider: string): string[] {
  const raw = DEFAULT_SCOPES[provider];
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Nango's comma-separated form; `undefined` when the provider has no default scopes. */
export function scopesForNango(provider: string, override?: string[] | null): string | undefined {
  const list = override && override.length > 0 ? override : defaultScopesFor(provider);
  return list.length > 0 ? list.join(",") : undefined;
}

export type OAuthAuthMode = IntegrationOAuthSetup["auth_mode"];

export function oauthAuthModeFor(provider: string): OAuthAuthMode {
  if (OAUTH1_PROVIDERS.has(provider)) return "oauth1";
  if (OAUTH2_CC_PROVIDERS.has(provider)) return "oauth2_cc";
  return "oauth2";
}

/** Nango's `credentials.type` for that auth mode. */
export function nangoCredentialTypeFor(mode: OAuthAuthMode): "OAUTH2" | "OAUTH1" | "OAUTH2_CC" {
  return mode === "oauth1" ? "OAUTH1" : mode === "oauth2_cc" ? "OAUTH2_CC" : "OAUTH2";
}

/**
 * Nango's OAuth callback: the redirect URI a customer registers on its own
 * app. Null when the instance has no Nango configured — there is no host to
 * name, and inventing one would send OAuth codes to a server nobody runs.
 */
export function nangoCallbackUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.NANGO_PUBLIC_URL || env.NANGO_SERVER_URL;
  if (!raw) return null;
  return `${raw.replace(/\/+$/, "")}/oauth/callback`;
}

export function consoleUrlFor(provider: string): string | null {
  const family = consoleFamily(provider);
  return family ? (CONSOLE_URLS[family] ?? null) : null;
}

/**
 * The `oauth_setup` block the catalog attaches to an OAuth Nango-backed
 * entry, or null without Nango (no callback to register, nothing to set up).
 */
export function oauthSetupFor(provider: string, env: NodeJS.ProcessEnv = process.env): IntegrationOAuthSetup | null {
  const callback_url = nangoCallbackUrl(env);
  if (!callback_url) return null;
  return {
    callback_url,
    scopes: defaultScopesFor(provider),
    console_url: consoleUrlFor(provider),
    auth_mode: oauthAuthModeFor(provider),
  };
}
