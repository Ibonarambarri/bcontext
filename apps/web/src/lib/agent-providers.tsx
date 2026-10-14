/**
 * Agent provider registry — brand identity for every runtime that connects
 * to Bcontext over MCP (or the REST surface).
 *
 * Detection is best-effort string matching over whatever identity signals a
 * connection left behind, in priority order:
 *
 *   1. `client_name` — the MCP `initialize` clientInfo.name the API persists
 *      on the connection, or the OAuth dynamic client registration name.
 *   2. `provider_label` / agent display name chosen at consent time.
 *   3. The legacy DB `provider` enum (codex | claude_code | hermes |
 *      openclaw | other).
 *
 * The regexes are calibrated against real clientInfo.name values observed in
 * the wild (see apify/mcp-client-capabilities): `claude-code`, `claude-ai`,
 * `cursor-vscode`, `Windsurf`, `Zed`, `gemini-cli-mcp-client`,
 * `github-copilot-developer`, `ChatGPT`, `Codex`, `Cline`, `goose`,
 * `com.raycast.macos`, `Visual Studio Code`.
 *
 * Order matters: more specific entries first — `claude-code` must win over
 * `claude`, `cursor-vscode` over `vscode`, `*-copilot-*` over `vscode`.
 *
 * Logos live in /public/agent-providers/<slug>-{light,dark}.svg — the light
 * variant is the black mark (for light backgrounds), the dark variant the
 * white mark. `ProviderLogo` renders both and lets the `.dark` /
 * `[data-theme]` root class pick one (same switch the whole app theme uses).
 */

export interface AgentProviderInfo {
  /** Stable slug — also the asset basename under /agent-providers. */
  slug: string;
  /** Human display name. */
  name: string;
  /** Case-insensitive matcher applied to each identity signal. */
  match: RegExp;
}

const AGENT_PROVIDER_REGISTRY: readonly AgentProviderInfo[] = [
  { slug: "claude-code", name: "Claude Code", match: /claude[\s_-]?code/i },
  { slug: "cursor", name: "Cursor", match: /cursor/i },
  { slug: "github-copilot", name: "GitHub Copilot", match: /copilot/i },
  {
    slug: "vscode",
    name: "VS Code",
    match: /visual[\s_-]?studio[\s_-]?code|\bvs[\s_-]?code\b/i,
  },
  { slug: "windsurf", name: "Windsurf", match: /windsurf|codeium/i },
  { slug: "zed", name: "Zed", match: /\bzed\b/i },
  { slug: "gemini-cli", name: "Gemini CLI", match: /gemini/i },
  {
    slug: "openai",
    name: "ChatGPT / Codex",
    match: /chatgpt|codex|openai|gpt[\s_-]?5/i,
  },
  {
    slug: "claude",
    name: "Claude",
    match: /claude|anthropic/i,
  },
  { slug: "cline", name: "Cline", match: /\bcline\b/i },
  { slug: "goose", name: "Goose", match: /\bgoose\b/i },
  { slug: "raycast", name: "Raycast", match: /raycast/i },
] as const;

const CUSTOM_AGENT_PROVIDER: AgentProviderInfo = {
  slug: "custom",
  name: "Custom / API",
  // Never matches — custom is only ever the explicit fallback.
  match: /$^/,
};

/** Registry + fallback, for pickers and filter dropdowns. */
export const ALL_AGENT_PROVIDERS: readonly AgentProviderInfo[] = [
  ...AGENT_PROVIDER_REGISTRY,
  CUSTOM_AGENT_PROVIDER,
];

export function agentProviderBySlug(slug: string | null | undefined): AgentProviderInfo {
  return ALL_AGENT_PROVIDERS.find((p) => p.slug === slug) ?? CUSTOM_AGENT_PROVIDER;
}

/**
 * Map a registry slug to the legacy DB `provider` enum + `provider_label`
 * pair persisted on `agents`. Only two registry entries have a dedicated
 * enum value; everything else is stored as `other` with the registry name
 * as the label so `detectProviderInfo` recovers the brand later.
 */
export function legacyProviderForSlug(slug: string): {
  provider: "codex" | "claude_code" | "hermes" | "openclaw" | "other";
  provider_label: string | null;
} {
  const info = agentProviderBySlug(slug);
  if (info.slug === "claude-code") return { provider: "claude_code", provider_label: null };
  if (info.slug === "openai") return { provider: "codex", provider_label: null };
  if (info.slug === CUSTOM_AGENT_PROVIDER.slug) return { provider: "other", provider_label: null };
  return { provider: "other", provider_label: info.name };
}

/**
 * Detect the provider from identity signals, highest-priority signal first.
 * Legacy DB enum values are normalized before matching so `codex` maps to
 * ChatGPT / Codex and `claude_code` to Claude Code; `hermes`, `openclaw`
 * and `other` intentionally fall through to Custom / API.
 */
export function detectProviderInfo(
  ...signals: Array<string | null | undefined>
): AgentProviderInfo {
  for (const raw of signals) {
    if (!raw) continue;
    const signal = raw === "other" || raw === "hermes" || raw === "openclaw" ? "" : raw;
    if (!signal) continue;
    for (const provider of AGENT_PROVIDER_REGISTRY) {
      if (provider.match.test(signal)) return provider;
    }
  }
  return CUSTOM_AGENT_PROVIDER;
}

function providerLogoSrc(slug: string, theme: "light" | "dark"): string {
  return `/agent-providers/${slug}-${theme}.svg`;
}

/**
 * Theme-aware provider mark. Renders both variants; a pair of CSS rules in
 * globals.css (keyed off the same `.dark` / `[data-theme="dark"]` root
 * class the ThemeScript toggles) shows exactly one. No hooks — safe in
 * server components (OAuth consent) and client components alike.
 */
export function ProviderLogo({
  provider,
  size = 18,
  className,
  alt,
}: {
  provider: AgentProviderInfo | string;
  size?: number;
  className?: string;
  alt?: string;
}) {
  const info = typeof provider === "string" ? agentProviderBySlug(provider) : provider;
  const label = alt ?? `${info.name} logo`;
  return (
    <span
      className={`provider-logo inline-flex shrink-0 items-center justify-center ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny local SVGs; next/image adds nothing */}
      <img
        src={providerLogoSrc(info.slug, "light")}
        alt={label}
        width={size}
        height={size}
        className="provider-logo__light"
        draggable={false}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny local SVGs; next/image adds nothing */}
      <img
        src={providerLogoSrc(info.slug, "dark")}
        alt=""
        aria-hidden
        width={size}
        height={size}
        className="provider-logo__dark"
        draggable={false}
      />
    </span>
  );
}
