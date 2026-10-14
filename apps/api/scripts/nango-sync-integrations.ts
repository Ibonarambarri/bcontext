/**
 * One-shot CLI: make sure every `available` Nango-backed catalog entry exists
 * as an integration in the Nango instance, `unique_key` === catalog key.
 *
 * Usage:
 *
 *   NANGO_SERVER_URL=https://nango.example.com NANGO_SECRET_KEY=… npm run nango:sync [-- --dry-run]
 *
 * Idempotent and append-only: an integration that already exists is never
 * touched (so real OAuth credentials the owner pasted in the dashboard are
 * never overwritten). OAuth providers are created with placeholder client
 * credentials (`NANGO_PLACEHOLDER_CREDENTIAL`) and read scopes; the owner
 * replaces them in the Nango dashboard (integration → Settings) once the
 * OAuth app exists. API_KEY / BASIC / TWO_STEP providers need no credentials
 * at the integration level — end users type theirs in the Connect UI.
 */
import { INTEGRATION_CATALOG } from "@/lib/connectors/catalog";
import {
  NANGO_PLACEHOLDER_CREDENTIAL,
  NangoClient,
  readNangoConfig,
  type NangoNewIntegrationCredentials,
} from "@/lib/nango/client";
import { nangoCredentialTypeFor, oauthAuthModeFor, scopesForNango } from "@/lib/nango/scopes";

function parseArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

function isOAuth(auth: string): boolean {
  return auth === "oauth2";
}



async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const config = readNangoConfig();
  if (!config) {
    console.error("Missing NANGO_SERVER_URL or NANGO_SECRET_KEY");
    process.exit(1);
  }
  const client = new NangoClient(config);

  const wanted = INTEGRATION_CATALOG.filter((e) => e.via === "nango" && e.status === "available" && e.nango_provider);
  const existing = new Map((await client.listIntegrationsWithCredentials()).map((row) => [row.uniqueKey, row]));

  const rows: Array<{ key: string; provider: string; auth: string; action: string; detail: string }> = [];
  for (const entry of wanted) {
    const provider = entry.nango_provider!;
    const present = existing.get(entry.key);
    if (present) {
      const detail =
        present.provider !== provider
          ? `provider mismatch: Nango has ${present.provider}`
          : present.credentials?.clientId === NANGO_PLACEHOLDER_CREDENTIAL
            ? "placeholder OAuth app — owner setup pending"
            : "ok";
      rows.push({ key: entry.key, provider, auth: entry.auth, action: "exists", detail });
      continue;
    }
    let credentials: NangoNewIntegrationCredentials | undefined;
    const mode = oauthAuthModeFor(provider);
    if (isOAuth(entry.auth) && mode !== "oauth2_cc") {
      const scopes = scopesForNango(provider);
      credentials = {
        type: nangoCredentialTypeFor(mode),
        client_id: NANGO_PLACEHOLDER_CREDENTIAL,
        client_secret: NANGO_PLACEHOLDER_CREDENTIAL,
        ...(scopes !== undefined ? { scopes } : {}),
      };
    }
    if (dryRun) {
      rows.push({ key: entry.key, provider, auth: entry.auth, action: "would create", detail: credentials ? "placeholder OAuth app" : "no credentials" });
      continue;
    }
    try {
      await client.createIntegration({ uniqueKey: entry.key, provider, displayName: entry.name, credentials });
      rows.push({ key: entry.key, provider, auth: entry.auth, action: "created", detail: credentials ? "placeholder OAuth app — owner setup pending" : "no credentials needed" });
    } catch (err) {
      rows.push({ key: entry.key, provider, auth: entry.auth, action: "FAILED", detail: err instanceof Error ? err.message : String(err) });
    }
  }

  const extra = [...existing.keys()].filter((k) => !wanted.some((e) => e.key === k));
  console.table(rows);
  if (extra.length) console.log(`In Nango but not available in the catalog: ${extra.join(", ")}`);
  const failed = rows.filter((r) => r.action === "FAILED").length;
  const pending = rows.filter((r) => r.detail.includes("owner setup pending")).length;
  console.log(`${rows.length} available Nango entries · ${rows.filter((r) => r.action === "created").length} created · ${failed} failed · ${pending} awaiting owner OAuth credentials`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
