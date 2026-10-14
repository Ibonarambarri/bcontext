"use client";

/**
 * Tools — tool providers grid, the `tools` system view (mounted through
 * `agents-dashboard.tsx`); each Nexo is granted providers from its own Tools
 * tab.
 *
 * Header row + collapsible filters bar (same pattern as the Agents grid in
 * agent-connections-tab.tsx) + one unified grid where every connected
 * surface lives: MCP servers, API/workflow tools and signed webhook
 * endpoints. Everything is added through the same "Add tool provider" flow,
 * which opens with a type selector and branches into `ProviderModal` or
 * `WebhookModal`.
 *
 * Data: providers from `GET /api/capabilities?surface=providers`, enriched
 * per card from `/api/capabilities/:id` (best-effort, non-blocking);
 * webhooks from `/api/webhooks/endpoints`. Discovery of an MCP server's
 * tools goes through `POST /api/capabilities/discover` before save, with
 * the same connection body as the save itself — including the pasted
 * bearer token / header value, which the API probes with and then stores in
 * its vault. That token lives only in `form` while the modal is open:
 * closing, going back or saving drops the whole form, and nothing here
 * logs, toasts or renders the connection body.
 * Pause/resume and edits are optimistic; deletes confirm first.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType } from "react";
import {
  Activity,
  CalendarDays,
  KeyRound,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Send,
  Server,
  SlidersHorizontal,
  Trash2,
  Webhook,
  Workflow,
  X,
} from "lucide-react";
import {
  AlertDialog,
  Button,
  Calendar,
  Card,
  Chip,
  DateField,
  DatePicker,
  Label,
  ListBox,
  Modal,
  Select,
  Tooltip,
} from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { type CalendarDate, parseDate } from "@internationalized/date";
import { CardActionsMenu } from "@/components/card-actions-menu";
import { GridSkeleton } from "@/components/skeletons";
import { useToast } from "@/components/workspace-context";
import { cn, formatRelative } from "@bcontext-dev/contract/utils";
import {
  type AuthType,
  type Capability,
  type DeclaredMcpMetadata,
  type DiscoveredTool,
  EMPTY_FORM,
  type ProviderDetail,
  type ProviderForm,
  type ProviderKind,
  buildConnection,
  buildProvenance,
  buildUpdateConnection,
  describeDiscoveredProvider,
  endpointHostFromProvenance,
  inferProviderMetadata,
  logoFromProvenance,
  mergeDiscoveryIntoForm,
  providerFormFromDetail,
  providerLogoSrc,
  sameConnection,
  sanitizeDeclaredMetadata,
  sanitizeUntrustedMetadata,
  slugify,
} from "./provider-shared";
import { ProviderModal } from "./provider-modal";
import { WebhookModal, type WebhookEndpointRow } from "./webhook-modal";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

/** Extra per-provider facts only available from the detail endpoint. */
interface ProviderFacts {
  authType: AuthType;
  toolCount: number;
}

type AddFlow =
  | { step: "select" }
  | { step: "provider" }
  | { step: "webhook" };

type GridItem =
  | { kind: "provider"; activityAt: string; provider: Capability }
  | { kind: "webhook"; activityAt: string; endpoint: WebhookEndpointRow };

interface ToolFilters {
  type: "" | ProviderKind | "webhook";
  auth: "" | AuthType | "hmac";
  status: "" | "live" | "disabled" | "paused";
  from: string;
  to: string;
}

const EMPTY_FILTERS: ToolFilters = { type: "", auth: "", status: "", from: "", to: "" };

export function ToolProvidersView({ workspace }: { workspace: WorkspaceAddress }) {
  const toast = useToast();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [providers, setProviders] = useState<Capability[]>([]);
  const [facts, setFacts] = useState<Map<string, ProviderFacts>>(new Map());
  const [webhooks, setWebhooks] = useState<WebhookEndpointRow[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [form, setForm] = useState<ProviderForm | null>(null);
  const [flow, setFlow] = useState<AddFlow | null>(null);
  const [filters, setFilters] = useState<ToolFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Capability | null>(null);
  const [deletingWebhook, setDeletingWebhook] = useState<WebhookEndpointRow | null>(null);
  const activeFilterCount = useMemo(
    () => Object.values(filters).filter((value) => value !== "").length,
    [filters],
  );

  const loadWebhooks = useCallback(async (wsId: string) => {
    try {
      const response = await fetch(`/api/webhooks/endpoints?workspace_id=${encodeURIComponent(wsId)}`, { cache: "no-store" });
      if (!response.ok) return; // webhook listing is best-effort; provider grid still renders
      const body = (await response.json().catch(() => ({}))) as { endpoints?: WebhookEndpointRow[] };
      setWebhooks(body.endpoints ?? []);
    } catch {
      /* best-effort */
    }
  }, []);

  const loadFacts = useCallback(async (wsId: string, capabilities: Capability[]) => {
    const results = await Promise.allSettled(capabilities.map(async (capability) => {
      const response = await fetch(
        `/api/capabilities/${capability.id}?workspace_id=${encodeURIComponent(wsId)}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const detail = (await response.json()) as ProviderDetail;
      const toolCount = capability.type === "mcp_server"
        ? detail.version?.contract?.tools?.length ?? 0
        : detail.version?.contract?.tool ? 1 : 0;
      return [capability.id, { authType: detail.connection?.auth_type ?? "none", toolCount }] as const;
    }));
    const next = new Map<string, ProviderFacts>();
    for (const result of results) if (result.status === "fulfilled") next.set(result.value[0], result.value[1]);
    setFacts(next);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The workspace id and `can_manage` come from the agents list response;
      // the capabilities routes want the id, not the org/slug address.
      const identityResponse = await fetch(`/api/agents/connections?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`, { cache: "no-store" });
      const identity = (await identityResponse.json().catch(() => ({}))) as {
        workspace?: { id: string };
        can_manage?: boolean;
        message?: string;
      };
      if (!identityResponse.ok || !identity.workspace?.id) {
        throw new Error(identity.message ?? `HTTP ${identityResponse.status}`);
      }
      setWorkspaceId(identity.workspace.id);
      setCanManage(Boolean(identity.can_manage));

      if (!identity.can_manage) {
        setProviders([]);
        setWebhooks([]);
        setFacts(new Map());
        return;
      }
      const catalogResponse = await fetch(`/api/capabilities?workspace_id=${identity.workspace.id}&surface=providers`, { cache: "no-store" });
      const catalog = (await catalogResponse.json().catch(() => ({}))) as { capabilities?: Capability[]; message?: string };
      if (!catalogResponse.ok) throw new Error(catalog.message ?? `HTTP ${catalogResponse.status}`);
      const rows = (catalog.capabilities ?? []).filter((item) => item.type === "mcp_server" || item.type === "workflow");
      setProviders(rows);
      // Enrichment is deliberately non-blocking best-effort: the grid renders
      // from the list response and fills auth/tool facts as they arrive.
      void loadFacts(identity.workspace.id, rows);
      void loadWebhooks(identity.workspace.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadFacts, loadWebhooks, workspace]);

  useEffect(() => { void load(); }, [load]);

  const items = useMemo<GridItem[]>(() => {
    const merged: GridItem[] = [
      ...providers.map((provider) => ({
        kind: "provider" as const,
        activityAt: provider.updated_at || provider.created_at,
        provider,
      })),
      ...webhooks.map((endpoint) => ({
        kind: "webhook" as const,
        activityAt: endpoint.last_delivery_at ?? endpoint.created_at,
        endpoint,
      })),
    ];
    // Most recent activity first.
    return merged.toSorted((left, right) => Date.parse(right.activityAt) - Date.parse(left.activityAt));
  }, [providers, webhooks]);

  const visibleItems = useMemo(() => items.filter((item) => {
    if (filters.type && (item.kind === "provider" ? item.provider.type !== filters.type : filters.type !== "webhook")) return false;
    if (filters.auth) {
      if (item.kind === "webhook") {
        if (filters.auth !== "hmac") return false;
      } else {
        const auth = facts.get(item.provider.id)?.authType;
        if (auth !== filters.auth) return false;
      }
    }
    if (filters.status) {
      const status = item.kind === "provider"
        ? item.provider.status === "approved" ? "live" : "disabled"
        : item.endpoint.paused ? "paused" : "live";
      if (status !== filters.status) return false;
    }
    if (filters.from && Date.parse(item.activityAt) < Date.parse(`${filters.from}T00:00:00.000Z`)) return false;
    if (filters.to && Date.parse(item.activityAt) > Date.parse(`${filters.to}T23:59:59.999Z`)) return false;
    return true;
  }), [facts, filters, items]);

  async function saveProvider() {
    if (!form || !workspaceId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const endpoint = new URL(form.endpointUrl);
      const persistedTitle = sanitizeUntrustedMetadata(form.title, 100);
      const persistedProvider = sanitizeUntrustedMetadata(form.provider, 100);
      const persistedDescription = sanitizeUntrustedMetadata(form.description, 500);
      const key = slugify(persistedTitle);
      const editing = Boolean(form.capabilityId);
      if (!editing && key.length < 2) throw new Error("Give the provider a longer name.");
      const workflowTool = {
        name: form.remoteTool.trim(),
        description: form.description.trim(),
        inputSchema: { type: "object", additionalProperties: true },
      };
      const contract = form.type === "mcp_server"
        ? { protocol: "mcp_streamable_http", tools: form.tools }
        : { protocol: "webhook", tool: workflowTool, method: "POST", safeRetry: false };
      const provenance = buildProvenance(form, endpoint);
      const response = await fetch(editing ? `/api/capabilities/${form.capabilityId}` : "/api/capabilities", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? {
          workspace_id: workspaceId,
          expected_updated_at: form.expectedUpdatedAt,
          type: form.type,
          provider: persistedProvider,
          title: persistedTitle,
          description: persistedDescription,
          environment: "production",
          provenance,
          connection: buildUpdateConnection(form, endpoint),
          contract,
        } : {
          workspace_id: workspaceId,
          key,
          type: form.type,
          provider: persistedProvider,
          title: persistedTitle,
          description: persistedDescription,
          environment: "production",
          provenance,
          status: "approved",
          connection: buildConnection(form, endpoint),
          contract,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        grants_revoked?: number;
        material_change?: boolean;
      };
      if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
      setForm(null);
      setFlow(null);
      await load();
      setNotice(editing
        ? body.material_change
          ? `Provider updated and moved to review.${body.grants_revoked ? ` ${body.grants_revoked} agent grant${body.grants_revoked === 1 ? " was" : "s were"} revoked.` : ""} Enable it after review, then grant it to the intended agents. `
          : "Provider updated."
        : "Provider added to the gateway.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function editProvider(capability: Capability) {
    if (!workspaceId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/capabilities/${capability.id}?workspace_id=${encodeURIComponent(workspaceId)}`,
        { cache: "no-store" },
      );
      const body = (await response.json().catch(() => ({}))) as ProviderDetail & { message?: string };
      if (!response.ok || !body.capability || !body.connection || !body.version) {
        throw new Error(body.message ?? `HTTP ${response.status}`);
      }
      setForm(providerFormFromDetail(body));
      setFlow({ step: "provider" });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function removeProvider(capability: Capability) {
    if (!workspaceId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const query = new URLSearchParams({
        workspace_id: workspaceId,
        expected_updated_at: capability.updated_at,
      });
      const response = await fetch(`/api/capabilities/${capability.id}?${query}`, { method: "DELETE" });
      const body = (await response.json().catch(() => ({}))) as { message?: string; grants_revoked?: number };
      if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
      setDeleting(null);
      await load();
      setNotice(body.grants_revoked
        ? `Provider removed and ${body.grants_revoked} agent grant${body.grants_revoked === 1 ? " was" : "s were"} revoked. Invocation history was preserved.`
        : "Provider removed. Invocation history was preserved.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function discover(candidate: ProviderForm | null = form): Promise<boolean> {
    if (!candidate || !workspaceId) return false;
    setSaving(true);
    setError(null);
    try {
      const endpoint = new URL(candidate.endpointUrl);
      const connection = buildConnection(candidate, endpoint);
      const response = await fetch("/api/capabilities/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, connection }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        tools?: DiscoveredTool[];
        logo_url?: string | null;
        provider?: { declared?: DeclaredMcpMetadata | null } | null;
        logo?: { source?: string | null } | null;
        message?: string;
      };
      if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
      const tools = body.tools ?? [];
      const endpointIdentity = inferProviderMetadata(candidate.endpointUrl);
      const provider = endpointIdentity?.provider || "MCP provider";
      const title = endpointIdentity?.title || provider;
      const description = describeDiscoveredProvider(provider || title, tools.length);
      const declaredMetadata = sanitizeDeclaredMetadata(body.provider?.declared);
      setForm((current) => {
        if (!current || !sameConnection(current, candidate)) return current;
        // Editing keeps the user's connection name — see mergeDiscoveryIntoForm.
        return mergeDiscoveryIntoForm(current, {
          title,
          provider,
          description,
          tools,
          logoUrl: body.logo_url ?? "",
          logoSource: body.logo?.source ?? "",
          declaredMetadata,
        });
      });
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(capability: Capability, status: "approved" | "disabled") {
    if (!workspaceId) return;
    // Optimistic (repo convention): the pause/resume flips in the grid
    // immediately; a failed PATCH reverts the snapshot with a toast.
    const previous = providers;
    setProviders((current) =>
      current.map((item) => (item.id === capability.id ? { ...item, status } : item)),
    );
    setError(null);
    try {
      const response = await fetch("/api/capabilities", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, id: capability.id, status }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
      // 200 = the optimistic state is the canonical state; no full reload
      // (load() would swap the whole grid back to its skeleton).
    } catch (cause) {
      setProviders(previous);
      toast.error(`Couldn’t ${status === "approved" ? "resume" : "pause"} the provider: ${(cause as Error).message}`);
    }
  }

  async function testWebhook(endpoint: WebhookEndpointRow) {
    setError(null);
    try {
      const response = await fetch(`/api/webhooks/endpoints/${endpoint.id}`, { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setNotice(`Test event queued for ${hostOf(endpoint.url)}.`);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function toggleWebhookPause(endpoint: WebhookEndpointRow) {
    // Optimistic (repo convention): flip paused locally, reconcile with the
    // canonical list in the background, revert + toast on failure.
    const previous = webhooks;
    setWebhooks((current) =>
      current.map((item) => (item.id === endpoint.id ? { ...item, paused: !endpoint.paused } : item)),
    );
    setError(null);
    try {
      const response = await fetch(`/api/webhooks/endpoints/${endpoint.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !endpoint.paused }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (workspaceId) void loadWebhooks(workspaceId);
    } catch (cause) {
      setWebhooks(previous);
      toast.error(`Couldn’t ${endpoint.paused ? "resume" : "pause"} the webhook: ${(cause as Error).message}`);
    }
  }

  async function removeWebhook(endpoint: WebhookEndpointRow) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/webhooks/endpoints/${endpoint.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setDeletingWebhook(null);
      if (workspaceId) await loadWebhooks(workspaceId);
      setNotice("Webhook endpoint deleted.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const startAdd = () => { setError(null); setNotice(null); setFlow({ step: "select" }); };
  const selectKind = (kind: ProviderKind | "signed_webhook") => {
    if (kind === "signed_webhook") {
      setFlow({ step: "webhook" });
      return;
    }
    setForm({ ...EMPTY_FORM, type: kind });
    setFlow({ step: "provider" });
  };
  const closeFlow = () => { setFlow(null); setForm(null); };
  const backToSelect = () => { setForm(null); setFlow({ step: "select" }); };

  return (
    <section className="mb-9">
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <h2 className="m-0 text-[15px] font-medium">Tool providers</h2>
          <p className="mt-0.5 text-[12px] text-[var(--ink-3)]">
            {loading ? "MCP servers, API workflows and signed webhooks." : `${items.length} connected · sorted by last activity`}
          </p>
        </div>
        <span className="ml-auto" />
        {canManage ? (
          <Button
            size="sm"
            variant={filtersOpen ? "secondary" : "outline"}
            aria-expanded={filtersOpen}
            aria-controls="tools-filters-panel"
            onPress={() => setFiltersOpen((open) => !open)}
            className={cn("gap-1.5", filtersOpen && "border-[var(--line-strong)]")}
          >
            <SlidersHorizontal
              size={13}
              className={cn(
                "transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
                filtersOpen && "rotate-90",
              )}
            />
            Filter
            {activeFilterCount > 0 ? (
              <Chip size="sm" variant="soft" color="accent" className="h-4 min-w-4 px-1 text-[10px]">
                {activeFilterCount}
              </Chip>
            ) : null}
          </Button>
        ) : null}
        {canManage ? (
          <Button size="sm" className="gap-1.5" onPress={startAdd}>
            <Plus size={14} /> Add tool provider
          </Button>
        ) : null}
      </div>

      {/* Collapsible filters — grid-rows height animation, no layout jumps. */}
      <div
        id="tools-filters-panel"
        inert={!filtersOpen}
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
          filtersOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className={cn(
              "transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
              filtersOpen ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0",
            )}
          >
            <ToolFiltersBar filters={filters} setFilters={setFilters} onRefresh={() => void load()} />
            {/* Breathing room that collapses with the panel. */}
            <div className="h-1" />
          </div>
        </div>
      </div>

      {notice ? <p className="my-3 rounded-md border border-[var(--accent)]/25 bg-[var(--accent-2)] px-3 py-2 text-[11.5px] text-[var(--accent)]">{notice}</p> : null}
      {error && !flow ? <p className="my-3 text-[12px] text-danger">{error}</p> : null}

      {loading ? (
        <GridSkeleton cards={6} minHeightClassName="min-h-[120px]" label="Loading tool providers" />
      ) : null}
      {!loading && !canManage ? (
        <div className="mt-5 rounded-[12px] border border-[var(--line)] bg-[var(--paper-2)] p-5 text-[12px] text-[var(--ink-3)]">
          Workspace admins manage tool providers and gateway credentials.
        </div>
      ) : null}
      {!loading && canManage && visibleItems.length > 0 ? (
        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visibleItems.map((item) => item.kind === "provider" ? (
            <ProviderCard
              key={`cap-${item.provider.id}`}
              provider={item.provider}
              facts={facts.get(item.provider.id) ?? null}
              workspaceId={workspaceId}
              canManage={canManage}
              saving={saving}
              onEdit={() => void editProvider(item.provider)}
              onToggle={() => void setStatus(item.provider, item.provider.status === "approved" ? "disabled" : "approved")}
              onDelete={() => setDeleting(item.provider)}
            />
          ) : (
            <WebhookCard
              key={`hook-${item.endpoint.id}`}
              endpoint={item.endpoint}
              canManage={canManage}
              saving={saving}
              onTest={() => void testWebhook(item.endpoint)}
              onTogglePause={() => void toggleWebhookPause(item.endpoint)}
              onDelete={() => setDeletingWebhook(item.endpoint)}
            />
          ))}
        </div>
      ) : null}
      {!loading && canManage && visibleItems.length === 0 ? (
        items.length > 0
          ? <p className="mt-8 py-6 text-center text-[12px] text-[var(--ink-3)]">No tool providers match these filters.</p>
          : <EmptyProviders onAdd={startAdd} />
      ) : null}

      {flow?.step === "select" ? <TypeSelectorModal onSelect={selectKind} onClose={closeFlow} /> : null}
      {flow?.step === "provider" && form && workspaceId ? (
        <ProviderModal
          workspaceId={workspaceId}
          form={form}
          saving={saving}
          error={error}
          onChange={(next) => { setError(null); setForm(next); }}
          onClose={closeFlow}
          onBack={form.capabilityId ? undefined : backToSelect}
          onDiscover={discover}
          onSave={() => void saveProvider()}
        />
      ) : null}
      {flow?.step === "webhook" && workspaceId ? (
        <WebhookModal
          workspaceId={workspaceId}
          onClose={closeFlow}
          onBack={backToSelect}
          onCreated={() => { if (workspaceId) void loadWebhooks(workspaceId); }}
        />
      ) : null}
      {deleting ? <DeleteProviderDialog provider={deleting} saving={saving} onClose={() => setDeleting(null)} onConfirm={() => void removeProvider(deleting)} /> : null}
      {deletingWebhook ? <DeleteWebhookDialog endpoint={deletingWebhook} saving={saving} onClose={() => setDeletingWebhook(null)} onConfirm={() => void removeWebhook(deletingWebhook)} /> : null}
    </section>
  );
}

/* ── Filters (Activity FiltersBar pattern, as in the Agents grid) ─────── */

function ToolFiltersBar({
  filters,
  setFilters,
  onRefresh,
}: {
  filters: ToolFilters;
  setFilters: React.Dispatch<React.SetStateAction<ToolFilters>>;
  onRefresh: () => void;
}) {
  const set = <K extends keyof ToolFilters>(key: K, value: ToolFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const activeCount = useMemo(() => Object.values(filters).filter((value) => value !== "").length, [filters]);
  const hasActiveFilters = activeCount > 0;

  return (
    <section
      aria-label="Tool provider filters"
      className="mt-4 rounded-[calc(var(--radius)+6px)] border border-border bg-surface/90 p-4 sm:p-5"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold tracking-tight text-foreground">Filter tool providers</h3>
        <Chip size="sm" variant={hasActiveFilters ? "soft" : "secondary"} color={hasActiveFilters ? "accent" : "default"}>
          <Chip.Label>{hasActiveFilters ? `${activeCount} active` : "No filters"}</Chip.Label>
        </Chip>
      </header>

      <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3">
        <FilterField label="Type" Icon={Server}>
          <FilterSelect
            aria-label="Type"
            value={filters.type}
            onChange={(value) => set("type", value as ToolFilters["type"])}
            items={[
              { id: "", label: "All types" },
              { id: "mcp_server", label: "MCP server" },
              { id: "workflow", label: "API / workflow" },
              { id: "webhook", label: "Signed webhook" },
            ]}
          />
        </FilterField>
        <FilterField label="Authentication" Icon={KeyRound}>
          <FilterSelect
            aria-label="Authentication"
            value={filters.auth}
            onChange={(value) => set("auth", value as ToolFilters["auth"])}
            items={[
              { id: "", label: "All auth" },
              { id: "none", label: "No auth" },
              { id: "oauth", label: "OAuth" },
              { id: "bearer", label: "Bearer token" },
              { id: "header", label: "Custom header" },
              { id: "hmac", label: "HMAC (webhook)" },
            ]}
          />
        </FilterField>
        <FilterField label="Status" Icon={Activity}>
          <FilterSelect
            aria-label="Status"
            value={filters.status}
            onChange={(value) => set("status", value as ToolFilters["status"])}
            items={[
              { id: "", label: "All statuses" },
              { id: "live", label: "Live" },
              { id: "disabled", label: "Disabled" },
              { id: "paused", label: "Paused (webhook)" },
            ]}
          />
        </FilterField>
      </div>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="grid flex-1 grid-cols-1 gap-3.5 sm:max-w-md sm:grid-cols-2">
          <FilterDate label="Active from" value={filters.from} onChange={(value) => set("from", value)} />
          <FilterDate label="Active to" value={filters.to} onChange={(value) => set("to", value)} />
        </div>
        <div className="flex items-center justify-end gap-2 sm:ml-auto">
          <Button variant="ghost" size="sm" isDisabled={!hasActiveFilters} onPress={() => setFilters(EMPTY_FILTERS)}>
            <X size={14} /> Clear
          </Button>
          <Tooltip delay={0}>
            <Button isIconOnly size="sm" variant="secondary" aria-label="Refresh tool providers" onPress={onRefresh}>
              <RefreshCw size={14} />
            </Button>
            <Tooltip.Content>
              <p>Refresh tool providers</p>
            </Tooltip.Content>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}

function toDateValue(iso: string): CalendarDate | null {
  if (!iso) return null;
  try {
    return parseDate(iso);
  } catch {
    return null;
  }
}

function FilterDate({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <DatePicker
      aria-label={label}
      value={toDateValue(value)}
      onChange={(next) => onChange(next ? next.toString() : "")}
      className="flex w-full min-w-0 flex-col gap-1.5"
    >
      <Label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        <CalendarDays size={13} className="opacity-80" />
        {label}
      </Label>
      <DateField.Group fullWidth className="text-foreground [&_.date-input-group__segment]:text-foreground">
        <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
        <DateField.Suffix>
          <DatePicker.Trigger>
            <DatePicker.TriggerIndicator />
          </DatePicker.Trigger>
        </DateField.Suffix>
      </DateField.Group>
      <DatePicker.Popover>
        <Calendar aria-label={label}>
          <Calendar.Header>
            <Calendar.YearPickerTrigger>
              <Calendar.YearPickerTriggerHeading />
              <Calendar.YearPickerTriggerIndicator />
            </Calendar.YearPickerTrigger>
            <Calendar.NavButton slot="previous" />
            <Calendar.NavButton slot="next" />
          </Calendar.Header>
          <Calendar.Grid>
            <Calendar.GridHeader>
              {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
            </Calendar.GridHeader>
            <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
          </Calendar.Grid>
          <Calendar.YearPickerGrid>
            <Calendar.YearPickerGridBody>
              {({ year }) => <Calendar.YearPickerCell year={year} />}
            </Calendar.YearPickerGridBody>
          </Calendar.YearPickerGrid>
        </Calendar>
      </DatePicker.Popover>
    </DatePicker>
  );
}

function FilterField({ label, Icon, children }: { label: string; Icon: ComponentType<{ size?: number; className?: string }>; children: React.ReactNode }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <Label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        <Icon size={13} className="opacity-80" />
        {label}
      </Label>
      {children}
    </div>
  );
}

function FilterSelect({
  "aria-label": ariaLabel,
  value,
  onChange,
  items,
}: {
  "aria-label": string;
  value: string;
  onChange: (value: string) => void;
  items: Array<{ id: string; label: string }>;
}) {
  return (
    <Select aria-label={ariaLabel} value={value} onChange={(key) => onChange(key == null ? "" : String(key))}>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {items.map((item) => (
            <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
              {item.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/* ── Add flow: type selector ─────────────────────────────────────────── */

const PROVIDER_TYPES: Array<{
  id: ProviderKind | "signed_webhook";
  Icon: typeof Server;
  title: string;
  description: string;
}> = [
  {
    id: "mcp_server",
    Icon: Server,
    title: "MCP server",
    description: "Connect a remote MCP endpoint. Bcontext discovers and imports its full tool catalog automatically.",
  },
  {
    id: "workflow",
    Icon: Workflow,
    title: "API / workflow",
    description: "Register a single HTTPS POST action — an API route or automation workflow agents can call as one tool.",
  },
  {
    id: "signed_webhook",
    Icon: Webhook,
    title: "Signed webhook",
    description: "Deliver workspace events to your URL as CloudEvents v1.0 signed with HMAC-SHA256, with DLQ on failure.",
  },
];

function TypeSelectorModal({ onSelect, onClose }: {
  onSelect: (kind: ProviderKind | "signed_webhook") => void;
  onClose: () => void;
}) {
  return (
    <Modal.Backdrop isOpen onOpenChange={(next) => { if (!next) onClose(); }}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog aria-label="Add tool provider" className="sm:max-w-[560px]">
          <Modal.CloseTrigger />
          <Modal.Header className="gap-1">
            <Modal.Heading>Add tool provider</Modal.Heading>
            <p className="text-[12.5px] leading-relaxed text-muted">
              Choose what you want to connect. Nothing is visible to agents until you grant it.
            </p>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-2 pb-6">
            {PROVIDER_TYPES.map(({ id, Icon, title, description }) => (
              <Button
                key={id}
                onPress={() => onSelect(id)}
                variant="outline"
                className="h-auto justify-start gap-3.5 rounded-[12px] border-[var(--line)] p-4 text-left font-normal transition-colors hover:border-[var(--ink-mute)] hover:bg-[var(--paper-2)]"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-[var(--line)] bg-[var(--paper-2)]">
                  <Icon size={17} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-[var(--ink)]">{title}</span>
                  <span className="mt-0.5 block whitespace-normal text-[11px] leading-relaxed text-[var(--ink-3)]">{description}</span>
                </span>
              </Button>
            ))}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/* ── Cards ───────────────────────────────────────────────────────────── */

function ProviderCard({ provider, facts, workspaceId, canManage, saving, onEdit, onToggle, onDelete }: {
  provider: Capability;
  facts: ProviderFacts | null;
  workspaceId: string | null;
  canManage: boolean;
  saving: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const host = endpointHostFromProvenance(provider.provenance);
  const isMcp = provider.type === "mcp_server";
  const live = provider.status === "approved";
  return (
    <Card className="group flex min-h-[120px] flex-col gap-0 rounded-[12px] border border-[var(--line)] bg-[var(--paper)] p-4 shadow-none transition-colors hover:border-[var(--ink-mute)]">
      <Card.Header className="flex-row items-center gap-3 p-0">
        <ProviderMark
          kind={isMcp ? "mcp_server" : "workflow"}
          capabilityId={provider.id}
          logoUrl={logoFromProvenance(provider.provenance)}
          workspaceId={workspaceId}
          endpointHost={host}
          version={provider.updated_at}
        />
        <Card.Title className="min-w-0 flex-1 truncate text-[14px] font-medium leading-tight text-[var(--ink)]">{provider.title}</Card.Title>
        <StateChip live={live} label={live ? "live" : provider.status} />
        {canManage ? (
          <CardActionsMenu
            ariaLabel={`Actions for ${provider.title}`}
            isDisabled={saving}
            actions={[
              { id: "edit", label: "Edit", Icon: Pencil },
              { id: "toggle", label: live ? "Disable" : "Enable", Icon: live ? Pause : Play },
              { id: "delete", label: "Delete", Icon: Trash2, danger: true },
            ]}
            onAction={(key) => {
              if (key === "edit") onEdit();
              else if (key === "toggle") onToggle();
              else if (key === "delete") onDelete();
            }}
          />
        ) : null}
      </Card.Header>
      <Card.Footer className="mt-auto flex items-center gap-2 border-t border-[var(--line)] p-0 pt-3">
        <span className="font-mono text-[10px] text-[var(--ink-3)]">{facts ? `${facts.toolCount} tool${facts.toolCount === 1 ? "" : "s"}` : "… tools"}</span>
        <span className="ml-auto min-w-0 truncate font-mono text-[10px] text-[var(--ink-mute)]">updated {formatRelative(provider.updated_at)}</span>
      </Card.Footer>
    </Card>
  );
}

function WebhookCard({ endpoint, canManage, saving, onTest, onTogglePause, onDelete }: {
  endpoint: WebhookEndpointRow;
  canManage: boolean;
  saving: boolean;
  onTest: () => void;
  onTogglePause: () => void;
  onDelete: () => void;
}) {
  const host = hostOf(endpoint.url);
  const live = !endpoint.paused;
  return (
    <Card className="group flex min-h-[120px] flex-col gap-0 rounded-[12px] border border-[var(--line)] bg-[var(--paper)] p-4 shadow-none transition-colors hover:border-[var(--ink-mute)]">
      <Card.Header className="flex-row items-center gap-3 p-0">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-[var(--line)] bg-[var(--paper-2)]">
          <Webhook size={18} />
        </div>
        <Card.Title className="min-w-0 flex-1 truncate text-[14px] font-medium leading-tight text-[var(--ink)]">{host}</Card.Title>
        <StateChip live={live} label={live ? "live" : "paused"} />
        {canManage ? (
          <CardActionsMenu
            ariaLabel={`Actions for ${host}`}
            isDisabled={saving}
            actions={[
              { id: "test", label: "Send test event", Icon: Send },
              { id: "toggle", label: endpoint.paused ? "Resume" : "Pause", Icon: endpoint.paused ? Play : Pause },
              { id: "delete", label: "Delete", Icon: Trash2, danger: true },
            ]}
            onAction={(key) => {
              if (key === "test") onTest();
              else if (key === "toggle") onTogglePause();
              else if (key === "delete") onDelete();
            }}
          />
        ) : null}
      </Card.Header>
      <Card.Footer className="mt-auto flex items-center gap-2 border-t border-[var(--line)] p-0 pt-3">
        <span className="font-mono text-[10px] text-[var(--ink-3)]">{endpoint.event_types.length} event{endpoint.event_types.length === 1 ? "" : "s"}</span>
        <span className="ml-auto min-w-0 truncate font-mono text-[10px] text-[var(--ink-mute)]">
          {endpoint.last_delivery_at ? `delivered ${formatRelative(endpoint.last_delivery_at)}` : "no deliveries yet"}
        </span>
      </Card.Footer>
    </Card>
  );
}

/* ── Delete confirmations ────────────────────────────────────────────── */

function DeleteProviderDialog({ provider, saving, onClose, onConfirm }: {
  provider: Capability;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return <AlertDialog.Backdrop
    isOpen
    onOpenChange={(next) => { if (!next && !saving) onClose(); }}
  >
    <AlertDialog.Container placement="center">
      <AlertDialog.Dialog aria-labelledby="delete-provider-title" className="w-full max-w-[440px]">
        <AlertDialog.Header className="flex-col items-start gap-0">
          <AlertDialog.Icon status="danger">
            <Trash2 size={15} />
          </AlertDialog.Icon>
          <AlertDialog.Heading id="delete-provider-title" className="mt-4 text-[15px] font-medium">Delete {provider.title}?</AlertDialog.Heading>
        </AlertDialog.Header>
        <AlertDialog.Body>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted">It will disappear from the gateway, all direct agent grants will be revoked and its local OAuth credential will be deleted. Version and invocation history stay available for audit.</p>
        </AlertDialog.Body>
        <AlertDialog.Footer className="flex">
          <Button isDisabled={saving} onPress={onClose} variant="outline" size="sm">Cancel</Button>
          <Button isDisabled={saving} onPress={onConfirm} variant="danger" size="sm" className="ml-auto gap-1.5"><Trash2 size={11} />{saving ? "Deleting…" : "Delete provider"}</Button>
        </AlertDialog.Footer>
      </AlertDialog.Dialog>
    </AlertDialog.Container>
  </AlertDialog.Backdrop>;
}

function DeleteWebhookDialog({ endpoint, saving, onClose, onConfirm }: {
  endpoint: WebhookEndpointRow;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return <AlertDialog.Backdrop
    isOpen
    onOpenChange={(next) => { if (!next && !saving) onClose(); }}
  >
    <AlertDialog.Container placement="center">
      <AlertDialog.Dialog aria-labelledby="delete-webhook-title" className="w-full max-w-[440px]">
        <AlertDialog.Header className="flex-col items-start gap-0">
          <AlertDialog.Icon status="danger">
            <Trash2 size={15} />
          </AlertDialog.Icon>
          <AlertDialog.Heading id="delete-webhook-title" className="mt-4 text-[15px] font-medium">Delete this webhook endpoint?</AlertDialog.Heading>
        </AlertDialog.Header>
        <AlertDialog.Body>
          <p className="mt-1 break-all font-mono text-[10.5px] text-[var(--ink-2)]">{endpoint.url}</p>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted">Event deliveries to this URL stop immediately and its signing secret is revoked. This cannot be undone.</p>
        </AlertDialog.Body>
        <AlertDialog.Footer className="flex">
          <Button isDisabled={saving} onPress={onClose} variant="outline" size="sm">Cancel</Button>
          <Button isDisabled={saving} onPress={onConfirm} variant="danger" size="sm" className="ml-auto gap-1.5"><Trash2 size={11} />{saving ? "Deleting…" : "Delete endpoint"}</Button>
        </AlertDialog.Footer>
      </AlertDialog.Dialog>
    </AlertDialog.Container>
  </AlertDialog.Backdrop>;
}

/* ── Small pieces ────────────────────────────────────────────────────── */

function ProviderMark({ kind, capabilityId, logoUrl, workspaceId, endpointHost, version }: { kind: ProviderKind; capabilityId: string; logoUrl: string | null; workspaceId: string | null; endpointHost: string | null; version: string }) {
  const [failed, setFailed] = useState(false);
  const src = workspaceId ? providerLogoSrc(workspaceId, capabilityId, version) : null;
  useEffect(() => setFailed(false), [src, logoUrl]);
  return <div title={src ? `Artwork resolved from ${endpointHost ?? "the provider domain"}; not identity verification.` : undefined} className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-[var(--line)] bg-[var(--paper-2)]">
    {src && !failed ? <img src={src} alt="" className="h-full w-full object-contain p-1.5" onError={() => setFailed(true)} /> : kind === "mcp_server" ? <Server size={18} /> : <Workflow size={18} />}
  </div>;
}

function StateChip({ live, label }: { live: boolean; label: string }) {
  return (
    <Chip size="sm" variant="soft" className="shrink-0 gap-1.5 capitalize">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: live ? "var(--success)" : "var(--ink-mute)" }} />
      {label}
    </Chip>
  );
}

function EmptyProviders({ onAdd }: { onAdd: () => void }) {
  return (
    <EmptyState className="mt-5 min-h-[260px] rounded-[12px] border border-dashed border-[var(--line)] bg-[var(--paper-2)]">
      <EmptyState.Header>
        <EmptyState.Media variant="icon">
          <Server size={18} />
        </EmptyState.Media>
        <EmptyState.Title>No tool providers yet</EmptyState.Title>
        <EmptyState.Description className="max-w-[430px]">
          Connect an MCP server, an API workflow or a signed webhook. Providers stay
          invisible until you grant them to an agent.
        </EmptyState.Description>
      </EmptyState.Header>
      <EmptyState.Content>
        <Button onPress={onAdd} size="sm" className="gap-1.5">
          <Plus size={11} /> Add tool provider
        </Button>
      </EmptyState.Content>
    </EmptyState>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
