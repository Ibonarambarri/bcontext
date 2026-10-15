"use client";

/**
 * Add agent — multi-step modal, opened from the Agents grid
 * (`agent-connections-tab.tsx`). It owns its own open state and the
 * "Add agent" button that triggers it.
 *
 * The step sequence depends on how the agent authenticates, because the
 * configuration must happen at the right moment for each method:
 *
 *   · OAuth   — Method → Connect. The popup stays minimal: it only explains
 *     how to point the runtime at the workspace's endpoint. Identity and
 *     access (agent name, role, permissions) are configured on the OAuth
 *     consent screen (/oauth/authorize) when the agent authenticates; the
 *     workspace is the endpoint's.
 *
 *   · API key — Method → Provider → Configure → Connect. Everything is
 *     collected up front (agent name, provider, objective, role,
 *     permissions, workspaces); "Create agent" (`POST /api/tokens/user`)
 *     mints the scoped token and the last step reveals it once, embedded in
 *     the provider config.
 *
 * The endpoint shown is this workspace's, `<current origin>/mcp/<org>/<ws>`
 * (`@/lib/mcp-endpoint`), which this app proxies to the API, so the
 * snippets work as pasted; the server is filed as `bcontext-<org>-<ws>` so a
 * project folder can carry its own `.mcp.json` per workspace.
 *
 * Both Connect steps end with the same guide (`AgentGuide`): wiring the MCP
 * gives the agent the tools, and the guide gives it the habits — the plugin
 * for Claude Code, the rules file to paste into the project
 * (`@/lib/agent-instructions`, with this workspace's address in it), the
 * session loop, and what else there is to switch on. A connected agent that
 * nobody told how to work here is the most common way a workspace stays
 * empty.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  Bot,
  Check,
  Compass,
  Copy,
  Globe,
  KeyRound,
  Loader2,
  Plus,
  ShieldCheck,
  Terminal,
  Workflow,
  Zap,
} from "lucide-react";
import { Button, Chip, Disclosure, Input, Modal, TextField } from "@heroui/react";
import { CodeBlock } from "@/components/ui/code-block";
import { Stepper } from "@/components/ui/stepper";
import { appUrl } from "@/lib/app-url";
import { SCOPES, type Scope } from "@bcontext-dev/contract/auth/scopes";
import { ROLE_SCOPES, type AgentRole } from "@bcontext-dev/contract/agents/connections";
import {
  ALL_AGENT_PROVIDERS,
  ProviderLogo,
  agentProviderBySlug,
  legacyProviderForSlug,
} from "@/lib/agent-providers";
import { cn } from "@bcontext-dev/contract/utils";
import { mcpTargetFor, type McpTarget } from "@/lib/mcp-endpoint";
import { agentInstructions, rulesFileFor } from "@/lib/agent-instructions";
import type { WorkspaceAddress } from "@/web/workspace-url";
import { useWorkspace } from "./workspace-context";
import { supabaseAuthConfigured } from "@/lib/public-env";

type AuthMethod = "oauth" | "token";

const OAUTH_STEPS_TITLES = ["Method", "Connect"] as const;
const TOKEN_STEPS_TITLES = ["Method", "Provider", "Configure", "Connect"] as const;

/**
 * Steps for each connection method. OAuth stays minimal on purpose — the
 * agent is configured on the consent screen, not in this popup. Exported
 * for tests.
 */
export function stepsForMethod(auth: AuthMethod): readonly string[] {
  return auth === "oauth" ? OAUTH_STEPS_TITLES : TOKEN_STEPS_TITLES;
}

const ROLE_COPY: Record<AgentRole, string> = {
  observer: "Read and search context",
  collaborator: "Read and write context",
  operator: "Context, chat and approved actions",
  custom: "Custom permission set",
};

/**
 * The server's static tool list (`TOOLS` in bcontext-api's `mcp/server.ts`),
 * for the Connect step. `tools/list` filters it per principal and adds the
 * capability gateway (`capability_search` / `capability_call`).
 */
const MCP_TOOLS: [string, string][] = [
  ["nodes", "get / list / search — one hit per node, block refs nested"],
  ["nodes_write", "create, update (if_updated_at), delete, checklist flip, attach"],
  ["subtasks", "a task's steps: list cards + progress, or get one in full"],
  ["subtasks_write", "add, update, toggle, reorder, delete ONE subtask by id"],
  ["goals", "the goal tree with status, progress, pace and contributes_to"],
  ["goals_write", "create a goal, check in a key result, close a cycle"],
  ["data", "datasets: schema, sample rows, server-side query"],
  ["data_write", "create a dataset from rows/csv, append or replace rows"],
  ["tags", "the workspace taxonomy, with usage counts and relations"],
  ["tags_write", "create, rename, merge, delete, link, set a node's tags"],
  ["views", "saved views: list, get, resolve, or run a query"],
  ["views_write", "create, duplicate, update, delete a saved view"],
  ["admin", "who can reach this workspace, with verbs and reach; preview a reach"],
  ["admin_write", "grant, revoke or invite a principal"],
  ["capabilities", "external MCP servers / webhooks: catalog, discover, status"],
  ["capabilities_write", "connect an endpoint, finish its OAuth, grant, disconnect"],
  ["skills", "list skill nodes, or get one as instructions to run yourself"],
  ["skills_write", "import a skill node from SKILL.md (versioned upsert)"],
  ["skills_run", "run a skill server-side with the server's model"],
  ["ask_rag", "synthesized answer, every claim cited [N]"],
  ["ask_nexo", "ask the memory: cited answer, confidence, freshness, gaps"],
  ["brief", "start here: counts, unblocked queue, open decisions, what changed"],
  ["list_changes", "incremental change feed (since / node_id)"],
  ["links_write", "typed edges: blocked_by, references…"],
  ["ingest", "the ingestion inbox: candidates proposed by connector signals"],
  ["ingest_write", "accept (creates the node + links) or dismiss a candidate"],
  ["ping", "health check"],
  ["list_workspaces", "list workspaces this token can reach"],
];

/**
 * Per-provider connection snippet. Exported for tests.
 * `slug` is a registry slug from src/lib/agent-providers. When a freshly
 * minted `token` is passed (API-key flow, after creation) it replaces the
 * YOUR_TOKEN / $BCONTEXT_MCP_TOKEN placeholders.
 */
export function agentConfig(
  slug: string,
  auth: AuthMethod,
  target: McpTarget,
  token?: string,
): string {
  const raw = rawAgentConfig(slug, auth, target);
  if (auth === "token" && token) {
    return raw.replaceAll("YOUR_TOKEN", token).replaceAll("$BCONTEXT_MCP_TOKEN", token);
  }
  return raw;
}

function rawAgentConfig(slug: string, auth: AuthMethod, { endpoint, serverName }: McpTarget): string {
  const bearer = `"Authorization: Bearer $BCONTEXT_MCP_TOKEN"`;
  const headers = auth === "token" ? { headers: { Authorization: "Bearer YOUR_TOKEN" } } : {};
  const genericJson = JSON.stringify(
    { mcpServers: { [serverName]: { url: endpoint, ...headers } } },
    null,
    2,
  );
  switch (slug) {
    case "claude-code":
      return auth === "oauth"
        ? `claude mcp add --transport http ${serverName} ${endpoint}`
        : `claude mcp add --transport http ${serverName} ${endpoint} --header ${bearer}`;
    case "claude":
      return `Claude Desktop / claude.ai → Settings → Connectors → Add custom connector\nName: ${serverName}\nURL: ${endpoint}${auth === "token" ? "\n\nCustom connectors authenticate via OAuth; prefer the OAuth method for Claude." : ""}`;
    case "cursor":
      return `Cursor → Settings → MCP → Add new MCP server, or .cursor/mcp.json:\n${genericJson}`;
    case "windsurf":
      return `~/.codeium/windsurf/mcp_config.json:\n${JSON.stringify({ mcpServers: { [serverName]: { serverUrl: endpoint, ...headers } } }, null, 2)}`;
    case "zed":
      return `Zed settings.json:\n${JSON.stringify({ context_servers: { [serverName]: { source: "custom", url: endpoint, ...headers } } }, null, 2)}`;
    case "gemini-cli":
      return auth === "oauth"
        ? `gemini mcp add --transport http ${serverName} ${endpoint}`
        : `gemini mcp add --transport http ${serverName} ${endpoint} --header ${bearer}`;
    case "github-copilot":
      return `.vscode/mcp.json (Copilot agent mode):\n${JSON.stringify({ servers: { [serverName]: { type: "http", url: endpoint, ...headers } } }, null, 2)}`;
    case "vscode":
      return `code --add-mcp '${JSON.stringify({ name: serverName, type: "http", url: endpoint, ...headers })}'`;
    case "openai":
      return auth === "oauth"
        ? `# Codex CLI\ncodex mcp add ${serverName} --url ${endpoint}\n\n# ChatGPT\nSettings → Connectors → Add MCP server\nURL: ${endpoint} · Authentication: OAuth`
        : `# Codex CLI\nexport BCONTEXT_MCP_TOKEN=YOUR_TOKEN\ncodex mcp add ${serverName} --url ${endpoint} --bearer-token-env-var BCONTEXT_MCP_TOKEN\n\n# ChatGPT\nSettings → Connectors → Add MCP server\nURL: ${endpoint} · Authentication: Bearer token`;
    case "cline":
      return `Cline → MCP Servers → Configure (cline_mcp_settings.json):\n${genericJson}`;
    case "goose":
      return `goose configure → Add Extension → Remote Extension (Streaming HTTP)\nName: ${serverName}\nEndpoint: ${endpoint}${auth === "token" ? "\nRequest header: Authorization: Bearer YOUR_TOKEN" : ""}`;
    case "raycast":
      return `Raycast → "Install Server" (MCP):\n${genericJson}`;
    default:
      return genericJson;
  }
}

export function AddAgentModal() {
  const { address, workspace, workspaces } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [auth, setAuth] = useState<AuthMethod>("oauth");
  const [providerSlug, setProviderSlug] = useState<string>("claude-code");

  // API-key branch — full agent configuration, collected before creation.
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [role, setRole] = useState<AgentRole>("collaborator");
  const [scopes, setScopes] = useState<Set<Scope>>(new Set(ROLE_SCOPES.collaborator));
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string } | null>(null);

  const origin = appUrl();
  const target = useMemo<McpTarget>(() => mcpTargetFor(origin, address), [origin, address]);
  const provider = agentProviderBySlug(providerSlug);
  const steps = stepsForMethod(auth);
  const stepName = steps[Math.min(step, steps.length - 1)]!;
  const config = useMemo(
    () => agentConfig(providerSlug, auth, target, created?.token),
    [providerSlug, auth, target, created],
  );

  function reset() {
    setStep(0);
    setName("");
    setObjective("");
    setRole("collaborator");
    setScopes(new Set(ROLE_SCOPES.collaborator));
    setWorkspaceIds(workspace ? [workspace.id] : []);
    setCreating(false);
    setCreateError(null);
    setCreated(null);
  }

  function chooseRole(next: AgentRole) {
    setRole(next);
    if (next !== "custom") setScopes(new Set(ROLE_SCOPES[next]));
  }

  function toggleScope(scope: Scope) {
    setRole("custom");
    setScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  function toggleWorkspace(id: string) {
    setWorkspaceIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  const configValid =
    name.trim().length > 0 && scopes.size > 0 && workspaceIds.length > 0;

  async function create() {
    setCreating(true);
    setCreateError(null);
    try {
      const legacy = legacyProviderForSlug(providerSlug);
      const response = await fetch("/api/tokens/user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          scopes: [...scopes],
          description: objective.trim() || undefined,
          provider: legacy.provider,
          provider_label: legacy.provider_label ?? undefined,
          role,
          workspace_ids: workspaceIds,
        }),
      });
      if (!response.ok) {
        if (response.status === 401 || !supabaseAuthConfigured()) {
          throw new Error(
            "Creating agent credentials needs a signed-in account — the demo workspace can't mint tokens. Everything above is exactly what a real session would submit.",
          );
        }
        const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
      }
      const data = (await response.json()) as { token: string };
      setCreated({ token: data.token });
      setStep((current) => current + 1);
    } catch (cause) {
      setCreateError((cause as Error).message);
    } finally {
      setCreating(false);
    }
  }

  const showBack = step > 0 && !(auth === "token" && stepName === "Connect" && created);
  const isLast = step === steps.length - 1;
  const isConfigure = auth === "token" && stepName === "Configure";
  const { endRef, reachedEnd, scrollToEnd } = useReachedEnd(isLast && open);

  return (
    <>
      <Button
        onPress={() => {
          reset();
          setOpen(true);
        }}
        size="sm"
        className="gap-1.5"
        data-tour="agents-add"
      >
        <Plus size={14} /> Add agent
      </Button>
      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container size="lg" scroll="inside">
          <Modal.Dialog aria-label="Add agent" className="relative sm:max-w-[760px]">
            <Modal.CloseTrigger />
            <Modal.Header className="gap-1">
              <Modal.Heading>Add agent</Modal.Heading>
              <p className="text-[12.5px] leading-relaxed text-muted">
                Connect a runtime to Bcontext. External MCP servers belong in Tools.
              </p>
              <Stepper orientation="horizontal" currentStep={step} size="sm" className="mt-3 w-full">
                {steps.map((title, index) => (
                  <Stepper.Step key={title}>
                    <Stepper.Indicator />
                    <Stepper.Content className="hidden sm:block">
                      <Stepper.Title className={cn("text-[11px]", index === step ? "text-foreground" : "text-muted")}>
                        {title}
                      </Stepper.Title>
                    </Stepper.Content>
                    {index < steps.length - 1 ? <Stepper.Separator /> : null}
                  </Stepper.Step>
                ))}
              </Stepper>
            </Modal.Header>

            <Modal.Body className="flex flex-col gap-4">
              {stepName === "Method" ? (
                <MethodStep auth={auth} setAuth={setAuth} endpoint={target.endpoint} />
              ) : null}
              {stepName === "Provider" ? (
                <ProviderStep providerSlug={providerSlug} setProviderSlug={setProviderSlug} />
              ) : null}
              {stepName === "Configure" ? (
                <ConfigureStep
                  providerSlug={providerSlug}
                  name={name}
                  setName={setName}
                  objective={objective}
                  setObjective={setObjective}
                  role={role}
                  chooseRole={chooseRole}
                  scopes={scopes}
                  toggleScope={toggleScope}
                  workspaces={workspaces.map((item) => ({ id: item.id, name: item.name, slug: item.slug }))}
                  workspaceIds={workspaceIds}
                  toggleWorkspace={toggleWorkspace}
                  error={createError}
                />
              ) : null}
              {stepName === "Connect" && auth === "oauth" ? (
                <OAuthConnectStep
                  providerSlug={providerSlug}
                  setProviderSlug={setProviderSlug}
                  config={config}
                  providerName={provider.name}
                  target={target}
                  address={address}
                />
              ) : null}
              {stepName === "Connect" && auth === "token" ? (
                <TokenConnectStep
                  providerSlug={providerSlug}
                  providerName={provider.name}
                  agentName={name.trim()}
                  token={created?.token ?? null}
                  config={config}
                  target={target}
                  address={address}
                  origin={origin}
                />
              ) : null}
              {isLast ? <div ref={endRef} aria-hidden className="h-px w-full shrink-0" /> : null}
            </Modal.Body>

            {isLast && !reachedEnd ? (
              <Button
                variant="secondary"
                size="sm"
                onPress={scrollToEnd}
                className="absolute bottom-[86px] left-1/2 z-10 -translate-x-1/2 gap-1.5 rounded-full border border-[var(--line)] bg-[var(--paper)] px-3.5 text-[11.5px] shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)]"
              >
                <ArrowDown size={12} /> Scroll for the setup guide
              </Button>
            ) : null}

            <Modal.Footer>
              {showBack ? (
                <Button variant="secondary" onPress={() => setStep(step - 1)}>
                  Back
                </Button>
              ) : (
                <Button variant="secondary" slot="close">
                  {isLast ? "Close" : "Cancel"}
                </Button>
              )}
              <span className="flex-1" />
              {isConfigure ? (
                <Button onPress={() => void create()} isDisabled={!configValid || creating} className="gap-1.5">
                  {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                  {creating ? "Creating…" : "Create agent"}
                </Button>
              ) : isLast ? (
                <Button slot="close" isDisabled={!reachedEnd}>
                  Done
                </Button>
              ) : (
                <Button onPress={() => setStep(step + 1)}>Continue</Button>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}

/* ── Step · Method ───────────────────────────────────────────────────── */

function MethodStep({
  auth,
  setAuth,
  endpoint,
}: {
  auth: AuthMethod;
  setAuth: (value: AuthMethod) => void;
  endpoint: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <StepTitle title="Choose how the agent authenticates" />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ChoiceCard
          active={auth === "oauth"}
          onPress={() => setAuth("oauth")}
          icon={<ShieldCheck size={15} />}
          title="OAuth"
          badge="Recommended"
          description="Nothing to configure here — point your runtime at the endpoint and it opens a consent screen where you name the agent and set its role and permissions."
        />
        <ChoiceCard
          active={auth === "token"}
          onPress={() => setAuth("token")}
          icon={<KeyRound size={15} />}
          title="API key"
          description="Configure the agent now — name, role, permissions, workspaces — and get a scoped token to paste into clients or scripts that don't speak OAuth."
        />
      </div>
      <div className="mono flex items-center gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--paper-2)] px-3.5 py-2.5 text-[12.5px] text-[var(--ink)]">
        <Globe size={14} className="shrink-0" />
        <span className="truncate">{endpoint}</span>
        <Button
          variant="ghost"
          onPress={() => {
            void navigator.clipboard?.writeText(endpoint);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          }}
          className="ml-auto h-auto min-w-0 gap-1 px-0 text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)]"
        >
          <Copy size={11} /> {copied ? "copied" : "copy URL"}
        </Button>
      </div>
      <p className="text-[11.5px] leading-relaxed text-[var(--ink-3)]">
        This URL is bound to this workspace: a client that connects through it can only reach
        this one, so each project folder can carry its own <span className="mono">.mcp.json</span>.
        OAuth discovery is published at{" "}
        <span className="mono">/.well-known/oauth-authorization-server</span> and{" "}
        <span className="mono">/.well-known/oauth-protected-resource</span>.
      </p>
    </div>
  );
}

/* ── Step · Provider (API key) ───────────────────────────────────────── */

function ProviderStep({
  providerSlug,
  setProviderSlug,
}: {
  providerSlug: string;
  setProviderSlug: (slug: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <StepTitle title="Which runtime is connecting?" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {ALL_AGENT_PROVIDERS.map((item) => (
          <Button
            key={item.slug}
            variant="outline"
            aria-pressed={providerSlug === item.slug}
            onPress={() => setProviderSlug(item.slug)}
            className={cn(
              "h-auto justify-start gap-2.5 rounded-lg border px-3 py-2.5 text-left text-[12.5px] font-normal",
              providerSlug === item.slug
                ? "border-[var(--ink)] bg-[var(--paper-2)]"
                : "border-[var(--line)]",
            )}
          >
            <ProviderLogo provider={item} size={18} />
            <span className="truncate">{item.name}</span>
            {providerSlug === item.slug ? <Check size={12} className="ml-auto shrink-0" /> : null}
          </Button>
        ))}
      </div>
      <p className="text-[11.5px] leading-relaxed text-[var(--ink-3)]">
        The provider brands the agent card and tailors the connection snippet on the last step.
      </p>
    </div>
  );
}

/* ── Step · Configure (API key) ──────────────────────────────────────── */

function ConfigureStep({
  providerSlug,
  name,
  setName,
  objective,
  setObjective,
  role,
  chooseRole,
  scopes,
  toggleScope,
  workspaces,
  workspaceIds,
  toggleWorkspace,
  error,
}: {
  providerSlug: string;
  name: string;
  setName: (value: string) => void;
  objective: string;
  setObjective: (value: string) => void;
  role: AgentRole;
  chooseRole: (role: AgentRole) => void;
  scopes: Set<Scope>;
  toggleScope: (scope: Scope) => void;
  workspaces: Array<{ id: string; name: string; slug: string }>;
  workspaceIds: string[];
  toggleWorkspace: (id: string) => void;
  error: string | null;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2.5">
        <ProviderLogo provider={providerSlug} size={20} />
        <StepTitle
          title="Configure the agent"
          sub="everything is set before the token is created — you can edit it later from the agent card"
        />
      </div>

      <ConfigSection icon={Bot} title="Identity">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Agent name" className="sm:col-span-2">
            <TextField aria-label="Agent name" value={name} onChange={setName} isRequired>
              <Input
                placeholder="e.g. Cursor · backend repo"
                maxLength={80}
                className="h-9 w-full rounded-[9px] border border-[var(--line)] bg-[var(--paper)] px-3 text-[13px] text-[var(--ink)] outline-none transition-colors focus:border-[var(--line-strong)]"
              />
            </TextField>
          </Field>
          <Field label="Objective · optional" className="sm:col-span-2">
            <TextField aria-label="Objective" value={objective} onChange={setObjective}>
              <Input
                placeholder="What this agent is responsible for"
                maxLength={240}
                className="h-9 w-full rounded-[9px] border border-[var(--line)] bg-[var(--paper)] px-3 text-[13px] text-[var(--ink)] outline-none transition-colors focus:border-[var(--line-strong)]"
              />
            </TextField>
          </Field>
        </div>
      </ConfigSection>

      <ConfigSection icon={ShieldCheck} title="Role">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(Object.keys(ROLE_COPY) as AgentRole[]).map((item) => (
            <ChoiceCard
              key={item}
              active={role === item}
              onPress={() => chooseRole(item)}
              icon={<ShieldCheck size={14} />}
              title={item[0]!.toUpperCase() + item.slice(1)}
              description={ROLE_COPY[item]}
            />
          ))}
        </div>
      </ConfigSection>

      <ConfigSection icon={KeyRound} title="Permissions">
        <div className="flex flex-wrap gap-1.5">
          {SCOPES.filter((scope) => scope !== "admin:*").map((scope) => {
            const active = scopes.has(scope);
            return (
              <Button
                key={scope}
                variant="outline"
                aria-pressed={active}
                onPress={() => toggleScope(scope)}
                className={cn(
                  "mono h-auto rounded-full border px-3 py-1.5 text-[10.5px] font-normal",
                  active
                    ? "border-[var(--ink)] bg-[var(--paper-2)] text-[var(--ink)]"
                    : "border-[var(--line)] text-[var(--ink-3)]",
                )}
              >
                {active ? <Check size={10} className="mr-1 inline" /> : null}
                {scope}
              </Button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--ink-3)]">
          External MCP tools and workflows are granted per agent from{" "}
          <span className="font-medium text-[var(--ink-2)]">Tools</span> after it connects.
        </p>
      </ConfigSection>

      <ConfigSection icon={Workflow} title="Workspace access">
        <p className="mb-2 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
          Select explicit workspaces. New workspaces are never added automatically.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {workspaces.map((item) => {
            const active = workspaceIds.includes(item.id);
            return (
              <Button
                key={item.id}
                variant="outline"
                aria-pressed={active}
                onPress={() => toggleWorkspace(item.id)}
                className={cn(
                  "h-auto items-start justify-start gap-2.5 rounded-[10px] border p-3 text-left font-normal",
                  active ? "border-[var(--ink)] bg-[var(--paper-2)]" : "border-[var(--line)]",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    active
                      ? "border-[var(--ink)] bg-[var(--ink)] text-[var(--paper)]"
                      : "border-[var(--line-strong)]",
                  )}
                >
                  {active ? <Check size={10} /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-[var(--ink)]">
                    {item.name}
                  </span>
                  <span className="mono text-[10.5px] text-[var(--ink-3)]">/{item.slug}</span>
                </span>
              </Button>
            );
          })}
        </div>
      </ConfigSection>

      {error ? (
        <p role="alert" className="text-[11.5px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ── Step · Connect (OAuth — minimal) ────────────────────────────────── */

function OAuthConnectStep({
  providerSlug,
  setProviderSlug,
  config,
  providerName,
  target,
  address,
}: {
  providerSlug: string;
  setProviderSlug: (slug: string) => void;
  config: string;
  providerName: string;
  target: McpTarget;
  address: WorkspaceAddress;
}) {
  return (
    <div className="flex flex-col gap-4">
      <StepTitle
        title={`Connect ${providerName} via OAuth`}
        sub="the agent is configured on the consent screen when it authenticates — not here"
      />

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Runtime">
        {ALL_AGENT_PROVIDERS.map((item) => (
          <Button
            key={item.slug}
            variant="outline"
            aria-pressed={providerSlug === item.slug}
            onPress={() => setProviderSlug(item.slug)}
            className={cn(
              "h-auto gap-1.5 rounded-full border px-3 py-1.5 text-[11.5px] font-normal",
              providerSlug === item.slug
                ? "border-[var(--ink)] bg-[var(--paper-2)] text-[var(--ink)]"
                : "border-[var(--line)] text-[var(--ink-3)]",
            )}
          >
            <ProviderLogo provider={item} size={13} />
            {item.name}
          </Button>
        ))}
      </div>

      <CodeBlock>
        <CodeBlock.Header>
          <span className="text-xs uppercase text-muted">
            {config.trimStart().startsWith("{") ? "json" : "shell / settings"}
          </span>
          <CodeBlock.CopyButton code={config} />
        </CodeBlock.Header>
        <CodeBlock.Code code={config} language={config.trimStart().startsWith("{") ? "json" : "shell"} />
      </CodeBlock>

      <p className="text-[12px] leading-relaxed text-[var(--ink-2)]">
        Run it. The client opens the Bcontext consent screen, where you name the agent and pick
        its role; the workspace is this one, and the agent then appears in this grid.
      </p>

      <AgentGuide providerSlug={providerSlug} target={target} address={address} />
    </div>
  );
}

/* ── Step · Connect (API key — token reveal + wiring) ────────────────── */

function TokenConnectStep({
  providerSlug,
  providerName,
  agentName,
  token,
  config,
  target,
  address,
  origin,
}: {
  providerSlug: string;
  providerName: string;
  agentName: string;
  token: string | null;
  config: string;
  target: McpTarget;
  address: WorkspaceAddress;
  origin: string;
}) {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [verified, setVerified] = useState<boolean | null>(null);
  const tokenValue = token ?? "YOUR_TOKEN";
  const oneLiner = `curl -sSL ${origin}/install/mcp | node - --url ${target.endpoint} --name ${target.serverName} --token ${tokenValue}`;
  const restSnippet = [
    `# read context (hybrid retrieval)`,
    `curl -s ${origin}/api/agents/context \\`,
    `  -H "Authorization: Bearer ${tokenValue}" \\`,
    `  --data-urlencode "q=what blocks the release?" -G`,
    ``,
    `# write a node (idempotent)`,
    `curl -s -X POST ${origin}/api/agents/write \\`,
    `  -H "Authorization: Bearer ${tokenValue}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Idempotency-Key: task-2026-07-20-example" \\`,
    `  -d '{"kind":"task","title":"Example","content_md":"## Goal\\n…"}'`,
  ].join("\n");
  async function verify() {
    setChecking(true);
    setVerified(null);
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      setVerified(response.ok);
    } catch {
      setVerified(false);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2.5">
        <ProviderLogo provider={providerSlug} size={20} />
        <StepTitle
          title={`Connect ${providerName}`}
          sub={agentName ? `${agentName} is created — wire the token into the client` : "via scoped API key"}
        />
      </div>

      {token ? (
        <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-2)] p-3.5">
          <div className="mono pb-2 text-[10.5px] uppercase tracking-[0.05em] text-[var(--ink-mute)]">
            Token created — copy it now, it won&apos;t be shown again
          </div>
          <div className="flex items-stretch gap-1.5">
            <code className="mono min-w-0 flex-1 overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-2 text-[11.5px] text-[var(--ink)]">
              {token}
            </code>
            <Button
              variant="outline"
              onPress={() => {
                void navigator.clipboard?.writeText(token);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              }}
              className="h-auto gap-1 rounded-md border-[var(--line)] px-2.5 text-[11.5px]"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--ink-3)]">
            The snippets below already include it. Rotate or revoke any time from the agent card.
          </p>
        </div>
      ) : null}

      <CodeBlock>
        <CodeBlock.Header>
          <span className="text-xs uppercase text-muted">
            {config.trimStart().startsWith("{") ? "json" : "shell / settings"}
          </span>
          <CodeBlock.CopyButton code={config} />
        </CodeBlock.Header>
        <CodeBlock.Code code={config} language={config.trimStart().startsWith("{") ? "json" : "shell"} />
      </CodeBlock>

      <AgentGuide providerSlug={providerSlug} target={target} address={address} />

      <SectionDisclosure icon={Terminal} label="Install in one command (writes the client config)">
        <CodeBlock>
          <CodeBlock.Header>
            <span className="text-xs uppercase text-muted">shell</span>
            <CodeBlock.CopyButton code={oneLiner} />
          </CodeBlock.Header>
          <CodeBlock.Code code={oneLiner} language="shell" />
        </CodeBlock>
        <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
          The installer writes the <span className="mono">mcpServers.{target.serverName}</span>{" "}
          entry into your client&apos;s config file — no JSON editing. Restart the client when it
          finishes.
        </p>
      </SectionDisclosure>

      <SectionDisclosure icon={Zap} label={`MCP tools (up to ${MCP_TOOLS.length}, by scope)`}>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {MCP_TOOLS.map(([toolName, desc]) => (
            <div
              key={toolName}
              className="flex items-start gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper-2)] px-3 py-2.5"
            >
              <span className="mt-0.5" style={{ color: "var(--accent)" }}>
                <Zap size={11} />
              </span>
              <div>
                <div className="mono text-[12px] text-[var(--ink)]">{toolName}</div>
                <div className="mt-0.5 text-[11.5px] text-[var(--ink-3)]">{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </SectionDisclosure>

      <SectionDisclosure icon={Globe} label="REST API — curl examples">
        <CodeBlock>
          <CodeBlock.Header>
            <span className="text-xs uppercase text-muted">shell</span>
            <CodeBlock.CopyButton code={restSnippet} />
          </CodeBlock.Header>
          <CodeBlock.Code code={restSnippet} language="shell" />
        </CodeBlock>
        <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
          All writes go through <span className="mono">/api/agents/write</span> with stable{" "}
          <span className="mono">Idempotency-Key</span> headers; reads through{" "}
          <span className="mono">/api/agents/context</span>. Same auth, scopes and audit as MCP.
        </p>
      </SectionDisclosure>

      <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-2)] p-3.5">
        <p className="text-[11.5px] leading-relaxed text-[var(--ink-3)]">
          After wiring the client, use its Bcontext <span className="mono">ping</span> tool. This
          check confirms the workspace gateway is reachable now.
        </p>
        <Button
          onPress={() => void verify()}
          isDisabled={checking}
          size="sm"
          variant="secondary"
          className="mt-2 gap-1.5"
        >
          {checking ? <Loader2 size={11} className="animate-spin" /> : verified ? <Check size={11} /> : null}
          {checking
            ? "Checking…"
            : verified === true
              ? "Gateway available"
              : verified === false
                ? "Retry verification"
                : "Verify endpoint"}
        </Button>
        {verified === false ? (
          <p role="alert" className="mt-2 text-[11px] text-danger">
            The gateway could not be reached. Keep the configuration and retry when service is
            restored.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ── Reading to the end ──────────────────────────────────────────────── */

/**
 * Whether the person has scrolled the last step to its end. "Done" waits
 * for it and a floating arrow points down until then: the setup guide sits
 * below the connection snippet, and a dialog closed on the snippet alone
 * is exactly how an agent ends up connected but untaught. A sentinel at the
 * bottom of the body reports through an IntersectionObserver, which also
 * counts as "reached" when the body is short enough not to scroll.
 */
function useReachedEnd(active: boolean) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const [reachedEnd, setReachedEnd] = useState(false);

  useEffect(() => {
    setReachedEnd(false);
    if (!active) return;
    const node = endRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setReachedEnd(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setReachedEnd(true);
      },
      { threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [active]);

  // scrollIntoView on the sentinel moved the modal's body a few pixels at
  // most in prod, so the nearest scrolling ancestor is scrolled by hand.
  const scrollToEnd = useCallback(() => {
    let node: HTMLElement | null = endRef.current?.parentElement ?? null;
    while (node) {
      const { overflowY } = getComputedStyle(node);
      if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
        node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
        return;
      }
      node = node.parentElement;
    }
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  return { endRef, reachedEnd, scrollToEnd };
}

/* ── After connecting: make the agent good at it ─────────────────────── */

const PLUGIN_INSTALL = [
  "/plugin marketplace add Bcontext-dev/bcontext-plugin",
  "/plugin install bcontext@bcontext",
].join("\n");

/** The session loop the rules file asks for, as four glanceable lines. */
const SESSION_LOOP: [string, string][] = [
  ["brief", "one call at the start: the queue, open decisions, what is yours, what changed"],
  ["ask_nexo", "before researching — what the team already knows, cited"],
  ["one task, in_progress", "its steps as subtasks; decisions as decision nodes linked to it"],
  ["done + ## Result", "what changed, what was decided, what is left — for the next reader"],
];

/** Everything else the workspace offers an agent, and where a person switches it on. */
const GO_FURTHER: [string, string][] = [
  ["Goals", "the North Star and the goals under it. Link tasks with contributes_to and the Roadmap fills itself; goals_write(checkin) moves a key result."],
  ["Integrations", "GitHub, Slack, Notion, Linear… from Integrations → Add integration. What they find lands in the ingest inbox for review, not straight in the graph."],
  ["Tools", "connect other MCP servers and webhooks once, grant them per agent. Agents find them with capability_search and call them with capability_call — no extra client config."],
  ["Skills", "skill nodes are instructions an agent runs (skills → get) or the server runs for it (skills_run); import one from a SKILL.md with skills_write."],
  ["Credentials", "one node per credential. Agents read them redacted and use them through materialize (needs credentials:use), so a secret never lands in a transcript."],
  ["Views", "saved queries the team shares; also the scope for ask_rag when a question is local."],
];

/**
 * What to do once the runtime is wired: teach it the conventions (the
 * plugin, for Claude Code), give the project a rules file with the workflow
 * in it, and know what else is there to switch on. The rules file is the
 * part people ask for most — "what do I put in CLAUDE.md?" — so it is
 * rendered ready to paste, with this workspace's address inside.
 */
function AgentGuide({
  providerSlug,
  target,
  address,
}: {
  providerSlug: string;
  target: McpTarget;
  address: WorkspaceAddress;
}) {
  const isClaudeCode = providerSlug === "claude-code";
  const rules = rulesFileFor(providerSlug);
  const instructions = agentInstructions(target, address, providerSlug);
  return (
    <div className="flex flex-col gap-3 border-t border-[var(--line)] pt-4">
      <StepTitle
        title="Make the agent good at it"
        sub="the MCP gives it the tools; these two minutes give it the habits"
      />

      <GuideBlock
        step="1"
        title={isClaudeCode ? "Install the plugin" : "The manual is built in"}
      >
        {isClaudeCode ? (
          <>
            <p className="mb-2 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
              Inside Claude Code. It ships the conventions as a skill the agent loads when it
              touches Bcontext — <span className="mono">brief</span> first, H2 blocks, subtasks,
              the <span className="mono">if_updated_at</span> rule — and{" "}
              <span className="mono">/bcontext:brief</span> for a standup of this workspace.
            </p>
            <CodeBlock>
              <CodeBlock.Header>
                <span className="text-xs uppercase text-muted">claude code</span>
                <CodeBlock.CopyButton code={PLUGIN_INSTALL} />
              </CodeBlock.Header>
              <CodeBlock.Code code={PLUGIN_INSTALL} language="shell" />
            </CodeBlock>
          </>
        ) : (
          <p className="text-[11.5px] leading-relaxed text-[var(--ink-3)]">
            The server&apos;s <span className="mono">instructions</span> on{" "}
            <span className="mono">initialize</span> are the short, accurate manual for this
            build, and every tool describes its own <span className="mono">op</span>s. Ask the
            agent to read them and start with <span className="mono">brief</span>. Claude Code
            users get the same as a plugin.
          </p>
        )}
      </GuideBlock>

      <GuideBlock step="2" title={`Put the workflow in ${rules.path}`}>
        <p className="mb-2 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
          The file your runtime reads at the start of every session in this project. Paste this
          at the top: it says where the project&apos;s memory is, how a session runs, and how to
          write so the next reader — human or agent — can use it. Edit it to taste; the workspace
          address is already yours.
        </p>
        <CodeBlock>
          <CodeBlock.Header>
            {/* A path, not a label: its case is part of the name. */}
            <span className="mono text-xs text-muted">{rules.path}</span>
            <CodeBlock.CopyButton code={instructions} />
          </CodeBlock.Header>
          {/* Prose to read, not a command to copy: wrap instead of scrolling sideways. */}
          <CodeBlock.Code
            code={instructions}
            language="markdown"
            className="max-h-72 overflow-y-auto [&_code]:whitespace-pre-wrap [&_pre]:whitespace-pre-wrap [&_pre]:break-words"
          />
        </CodeBlock>
      </GuideBlock>

      <GuideBlock step="3" title="The loop, every session">
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {SESSION_LOOP.map(([name, desc]) => (
            <div key={name} className="rounded-lg border border-[var(--line)] bg-[var(--paper-2)] px-3 py-2">
              <div className="mono text-[11.5px] text-[var(--ink)]">{name}</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--ink-3)]">{desc}</div>
            </div>
          ))}
        </div>
      </GuideBlock>

      <SectionDisclosure icon={Compass} label="Go further — what else the agent can use">
        <ul className="flex flex-col gap-2">
          {GO_FURTHER.map(([name, desc]) => (
            <li key={name} className="text-[11.5px] leading-relaxed text-[var(--ink-3)]">
              <span className="font-medium text-[var(--ink-2)]">{name}</span> — {desc}
            </li>
          ))}
        </ul>
      </SectionDisclosure>
    </div>
  );
}

function GuideBlock({
  step,
  title,
  children,
}: {
  step: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[12px] border border-[var(--line)] bg-[var(--paper)] p-3.5">
      <h4 className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-[var(--ink)]">
        <span className="mono flex h-5 w-5 items-center justify-center rounded-full border border-[var(--line-strong)] text-[10px] text-[var(--ink-3)]">
          {step}
        </span>
        {title}
      </h4>
      {children}
    </section>
  );
}

/* ── Shared bits ─────────────────────────────────────────────────────── */

function StepTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div>
      <h3 className="text-[13.5px] font-medium text-foreground">{title}</h3>
      {sub ? <p className="mt-0.5 text-[11.5px] text-[var(--ink-3)]">{sub}</p> : null}
    </div>
  );
}

function ConfigSection({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Bot;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[12px] border border-[var(--line)] bg-[var(--paper)] p-4">
      <h4 className="mb-3 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--ink-mute)]">
        <Icon size={11} />
        {title}
      </h4>
      {children}
    </section>
  );
}

function Field({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5 text-[11px] text-[var(--ink-3)]", className)}>
      {label}
      {children}
    </label>
  );
}

function ChoiceCard({
  active,
  onPress,
  icon,
  title,
  badge,
  description,
}: {
  active: boolean;
  onPress: () => void;
  icon: React.ReactNode;
  title: string;
  badge?: string;
  description: string;
}) {
  return (
    <Button
      variant="outline"
      aria-pressed={active}
      onPress={onPress}
      className={cn(
        "h-auto flex-col items-start gap-1 rounded-lg border p-3.5 text-left font-normal",
        active ? "border-[var(--ink)] bg-[var(--paper-2)]" : "border-[var(--line)]",
      )}
    >
      <span className="flex w-full items-center gap-2">
        {icon}
        <span className="text-[12.5px] font-medium">{title}</span>
        {badge ? (
          <Chip size="sm" variant="soft" color="accent" className="ml-auto text-[10px]">
            {badge}
          </Chip>
        ) : null}
        {active && !badge ? <Check size={12} className="ml-auto" /> : null}
      </span>
      <span className="block whitespace-normal text-[11px] leading-relaxed text-[var(--ink-3)]">
        {description}
      </span>
    </Button>
  );
}

function SectionDisclosure({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Zap;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Disclosure className="rounded-lg border border-[var(--line)] bg-[var(--paper)]">
      <Disclosure.Heading>
        <Button
          slot="trigger"
          variant="ghost"
          fullWidth
          className="h-auto w-full justify-start gap-2 rounded-lg px-3.5 py-2.5 text-[12px] font-medium text-[var(--ink-2)]"
        >
          <Icon size={13} className="text-[var(--ink-3)]" />
          {label}
          <Disclosure.Indicator className="ml-auto" />
        </Button>
      </Disclosure.Heading>
      <Disclosure.Content>
        <div className="px-3.5 pb-3.5">{children}</div>
      </Disclosure.Content>
    </Disclosure>
  );
}
