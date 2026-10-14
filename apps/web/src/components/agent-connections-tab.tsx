"use client";

/**
 * Agents — the external agents (Claude Code, Cursor…) grid, the `agents`
 * system view (mounted through `agents-dashboard.tsx`). The Nexos themselves
 * are agents too on the API side (provider `nexo`); they are listed on the
 * Nexos page, never here.
 *
 * Header row + filters bar (same pattern as the Activity FiltersBar in
 * changes-view.tsx) + minimal provider-branded cards (same anatomy as the
 * Tools grid in tools/tool-providers-view.tsx) sorted by last MCP activity.
 * Card actions live in a kebab menu; editing happens in a modal window, and
 * everything about connecting a new agent (endpoint, client config, token
 * reveal) lives inside AddAgentModal.
 *
 * Data: `GET /api/agents/connections` for the list; edits `PATCH` and
 * disconnects `DELETE` the same route. Edits are optimistic, disconnects
 * confirm first (the repo convention for destructive actions).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType } from "react";
import {
  Activity,
  Bot,
  CalendarDays,
  Check,
  Copy,
  KeyRound,
  Pencil,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Unplug,
  UserRound,
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
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Skeleton,
  TextArea,
  TextField,
  Tooltip,
} from "@heroui/react";
import { CheckboxButtonGroup } from "@/components/ui/button-groups";
import { EmptyState } from "@/components/ui/empty-state";
import { appUrl } from "@/lib/app-url";
import { CardActionsMenu } from "./card-actions-menu";
import { type CalendarDate, parseDate } from "@internationalized/date";
import { SCOPES, type Scope } from "@bcontext-dev/contract/auth/scopes";
import {
  ROLE_SCOPES,
  type AgentProvider,
  type AgentRole,
} from "@bcontext-dev/contract/agents/connections";
import {
  ALL_AGENT_PROVIDERS,
  ProviderLogo,
  detectProviderInfo,
  type AgentProviderInfo,
} from "@/lib/agent-providers";
import { cn, formatRelative } from "@bcontext-dev/contract/utils";
import { AddAgentModal } from "./add-agent-modal";
import { GridSkeleton } from "./skeletons";
import { useToast, useWorkspace } from "./workspace-context";
import { workspaceMcpEndpoint } from "@/lib/mcp-endpoint";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

interface AgentVM {
  id: string;
  name: string;
  provider: AgentProvider;
  provider_label: string | null;
  description: string;
  status: "active" | "revoked";
  role: AgentRole;
  scopes: Scope[];
  created_at: string;
  approved_at: string;
  last_seen_at: string | null;
  client_name?: string | null;
  workspace_count: number;
  session_count: number;
  capability_ids: string[];
  bundle_ids: string[];
  can_edit_identity: boolean;
}

interface CapabilityVM {
  id: string;
  title: string;
  provider: string;
  type: string;
}

interface BundleVM {
  id: string;
  title: string;
}

interface Payload {
  can_manage: boolean;
  agents: AgentVM[];
  capabilities: CapabilityVM[];
  bundles: BundleVM[];
}

const ROLE_COPY: Record<AgentRole, string> = {
  observer: "Read and search context",
  collaborator: "Read and write context",
  operator: "Context, chat and approved actions",
  custom: "Custom permission set",
};

type ConnectionStateKey = "active" | "recent" | "stale" | "never";

interface AgentFilters {
  provider: string;
  role: "" | AgentRole;
  state: "" | ConnectionStateKey;
  from: string;
  to: string;
}

const EMPTY_FILTERS: AgentFilters = { provider: "", role: "", state: "", from: "", to: "" };

function agentProviderInfo(agent: AgentVM): AgentProviderInfo {
  return detectProviderInfo(
    agent.client_name,
    agent.provider,
    agent.provider_label,
    agent.name,
  );
}

export function AgentConnectionsTab({ workspace }: { workspace: WorkspaceAddress }) {
  const toast = useToast();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AgentVM | null>(null);
  const [disconnecting, setDisconnecting] = useState<AgentVM | null>(null);
  const [saving, setSaving] = useState(false);
  const [filters, setFilters] = useState<AgentFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount = useMemo(
    () => Object.values(filters).filter((value) => value !== "").length,
    [filters],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/agents/connections?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`, { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as Payload & { message?: string };
      if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
      // A Nexo is backed by an agent row; it has its card on the Nexos page.
      setData({ ...body, agents: (body.agents ?? []).filter((agent) => (agent.provider as string) !== "nexo") });
      setSelected((current) => current ? body.agents.find((agent) => agent.id === current.id) ?? null : null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [workspace]);

  useEffect(() => { void load(); }, [load]);

  const visibleAgents = useMemo(() => {
    const agents = data?.agents ?? [];
    const filtered = agents.filter((agent) => {
      if (filters.provider && agentProviderInfo(agent).slug !== filters.provider) return false;
      if (filters.role && agent.role !== filters.role) return false;
      if (filters.state && connectionState(agent.last_seen_at).key !== filters.state) return false;
      if (filters.from || filters.to) {
        if (!agent.last_seen_at) return false;
        const seen = Date.parse(agent.last_seen_at);
        if (filters.from && seen < Date.parse(`${filters.from}T00:00:00.000Z`)) return false;
        if (filters.to && seen > Date.parse(`${filters.to}T23:59:59.999Z`)) return false;
      }
      return true;
    });
    // Last MCP activity first; never-seen agents sink to the bottom.
    return filtered.toSorted((a, b) => {
      const seenA = a.last_seen_at ? Date.parse(a.last_seen_at) : Number.NEGATIVE_INFINITY;
      const seenB = b.last_seen_at ? Date.parse(b.last_seen_at) : Number.NEGATIVE_INFINITY;
      if (seenA !== seenB) return seenB - seenA;
      return Date.parse(b.approved_at) - Date.parse(a.approved_at);
    });
  }, [data, filters]);

  async function save(agent: AgentVM) {
    // Optimistic (repo convention): the edited agent shows in the grid
    // immediately; the canonical reload happens in the background and a
    // failure reverts the snapshot with a toast.
    const previous = data;
    if (previous) {
      setData({
        ...previous,
        agents: previous.agents.map((item) => (item.id === agent.id ? { ...agent } : item)),
      });
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/agents/connections/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: workspaceApiRef(workspace),
          name: agent.name,
          provider: agent.provider,
          provider_label: agent.provider_label,
          description: agent.description,
          role: agent.role,
          scopes: agent.scopes,
          capability_ids: agent.capability_ids,
          bundle_ids: agent.bundle_ids,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
      await load();
    } catch (cause) {
      if (previous) setData(previous);
      toast.error(`Couldn’t save the agent: ${(cause as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function disconnect(agent: AgentVM) {
    // Confirmed in DisconnectAgentDialog — destructive actions keep an
    // explicit confirmation (repo convention), unlike the optimistic edits.
    setSaving(true);
    try {
      const response = await fetch(`/api/agents/connections/${agent.id}?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setDisconnecting(null);
      setSelected(null);
      await load();
    } catch (cause) {
      toast.error(`Couldn’t disconnect ${agent.name}: ${(cause as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (!data && !error) {
    // Header + grid skeleton in the same anatomy the loaded surface uses,
    // so cards stream in without any layout shift.
    return (
      <>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <h2 className="m-0 text-[15px] font-medium">Connected agents</h2>
            <p className="mt-0.5 text-[12px] text-[var(--ink-3)]">
              Identity, workspace policy and grants in one place.
            </p>
          </div>
          <span className="ml-auto" />
          {/* Ghosts for the Filter + Add agent buttons so the header doesn't pop. */}
          <Skeleton className="h-8 w-20 rounded-lg" />
          <Skeleton className="h-8 w-28 rounded-lg" />
        </div>
        <GridSkeleton cards={6} minHeightClassName="min-h-[120px]" label="Loading connected agents" />
      </>
    );
  }

  return (
    <>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <h2 className="m-0 text-[15px] font-medium">Connected agents</h2>
          <p className="mt-0.5 text-[12px] text-[var(--ink-3)]">
            {data ? `${data.agents.length} connected · sorted by last MCP activity` : "Identity, workspace policy and grants in one place."}
          </p>
        </div>
        <span className="ml-auto" />
        <Button
          size="sm"
          variant={filtersOpen ? "secondary" : "outline"}
          aria-expanded={filtersOpen}
          aria-controls="agent-filters-panel"
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
        <AddAgentModal />
      </div>

      {/* Collapsible filters — grid-rows height animation, no layout jumps. */}
      <div
        id="agent-filters-panel"
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
            <AgentFiltersBar filters={filters} setFilters={setFilters} onRefresh={() => void load()} />
            {/* Breathing room that collapses with the panel. */}
            <div className="h-1" />
          </div>
        </div>
      </div>

      {error ? <p className="my-3 text-[12px] text-danger">{error}</p> : null}

      {visibleAgents.length ? (
        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visibleAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              canManage={Boolean(data?.can_manage)}
              saving={saving}
              onEdit={() => setSelected({ ...agent })}
              onDisconnect={() => setDisconnecting(agent)}
            />
          ))}
        </div>
      ) : data?.agents.length ? (
        <p className="mt-8 py-6 text-center text-[12px] text-[var(--ink-3)]">No agents match these filters.</p>
      ) : (
        <EmptyAgents />
      )}

      {selected && data ? (
        <AgentEditModal
          agent={selected}
          capabilities={data.capabilities}
          bundles={data.bundles}
          canManage={data.can_manage}
          saving={saving}
          onChange={setSelected}
          onSave={() => {
            // Optimistic (repo convention): the modal closes immediately;
            // save() already reverts the grid + toasts if the PATCH fails.
            void save(selected);
            setSelected(null);
          }}
          onDisconnectRequest={() => setDisconnecting(selected)}
          onClose={() => setSelected(null)}
        />
      ) : null}
      {disconnecting ? (
        <DisconnectAgentDialog
          agent={disconnecting}
          saving={saving}
          onClose={() => setDisconnecting(null)}
          onConfirm={() => void disconnect(disconnecting)}
        />
      ) : null}
    </>
  );
}

/* ── Filters (Activity FiltersBar pattern) ───────────────────────────── */

function AgentFiltersBar({
  filters,
  setFilters,
  onRefresh,
}: {
  filters: AgentFilters;
  setFilters: React.Dispatch<React.SetStateAction<AgentFilters>>;
  onRefresh: () => void;
}) {
  const set = <K extends keyof AgentFilters>(key: K, value: AgentFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const activeCount = useMemo(() => Object.values(filters).filter((value) => value !== "").length, [filters]);
  const hasActiveFilters = activeCount > 0;

  return (
    <section
      aria-label="Agent filters"
      className="mt-4 rounded-[calc(var(--radius)+6px)] border border-border bg-surface/90 p-4 sm:p-5"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold tracking-tight text-foreground">Filter agents</h3>
        <Chip size="sm" variant={hasActiveFilters ? "soft" : "secondary"} color={hasActiveFilters ? "accent" : "default"}>
          <Chip.Label>{hasActiveFilters ? `${activeCount} active` : "No filters"}</Chip.Label>
        </Chip>
      </header>

      <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3">
        <FilterField label="Provider" Icon={Bot}>
          <FilterSelect
            aria-label="Provider"
            value={filters.provider}
            onChange={(value) => set("provider", value)}
            items={[
              { id: "", label: "All providers" },
              ...ALL_AGENT_PROVIDERS.map((provider) => ({ id: provider.slug, label: provider.name })),
            ]}
          />
        </FilterField>
        <FilterField label="Role" Icon={UserRound}>
          <FilterSelect
            aria-label="Role"
            value={filters.role}
            onChange={(value) => set("role", value as AgentFilters["role"])}
            items={[
              { id: "", label: "All roles" },
              ...(Object.keys(ROLE_COPY) as AgentRole[]).map((role) => ({ id: role, label: role })),
            ]}
          />
        </FilterField>
        <FilterField label="Status" Icon={Activity}>
          <FilterSelect
            aria-label="Status"
            value={filters.state}
            onChange={(value) => set("state", value as AgentFilters["state"])}
            items={[
              { id: "", label: "All statuses" },
              { id: "active", label: "Active (15 min)" },
              { id: "recent", label: "Recent (7 days)" },
              { id: "stale", label: "Stale" },
              { id: "never", label: "Never seen" },
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
            <Button isIconOnly size="sm" variant="secondary" aria-label="Refresh agents" onPress={onRefresh}>
              <RefreshCw size={14} />
            </Button>
            <Tooltip.Content>
              <p>Refresh agents</p>
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

/* ── Cards ───────────────────────────────────────────────────────────── */

function AgentCard({ agent, canManage, saving, onEdit, onDisconnect }: {
  agent: AgentVM;
  canManage: boolean;
  saving: boolean;
  onEdit: () => void;
  onDisconnect: () => void;
}) {
  const state = connectionState(agent.last_seen_at);
  const provider = agentProviderInfo(agent);
  return (
    <Card className="group flex min-h-[120px] flex-col gap-0 rounded-[12px] border border-[var(--line)] bg-[var(--paper)] p-4 shadow-none transition-colors hover:border-[var(--ink-mute)]">
      <Card.Header className="flex-row items-center gap-3 p-0">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-[var(--line)] bg-[var(--paper-2)]">
          <ProviderLogo provider={provider} size={20} />
        </div>
        <Card.Title className="min-w-0 flex-1 truncate text-[14px] font-medium leading-tight text-[var(--ink)]">{agent.name}</Card.Title>
        <Chip size="sm" variant="soft" className="shrink-0 gap-1.5 capitalize">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: state.color }} />
          {state.label}
        </Chip>
        <CardActionsMenu
          ariaLabel={`Actions for ${agent.name}`}
          isDisabled={saving}
          actions={[
            { id: "edit", label: canManage ? "Edit" : "View details", Icon: Pencil },
            ...(canManage ? [{ id: "disconnect", label: "Disconnect", Icon: Unplug, danger: true }] : []),
          ]}
          onAction={(key) => {
            if (key === "edit") onEdit();
            else if (key === "disconnect") onDisconnect();
          }}
        />
      </Card.Header>
      <Card.Footer className="mt-auto flex items-center gap-2 border-t border-[var(--line)] p-0 pt-3">
        <span className="font-mono text-[10px] capitalize text-[var(--ink-3)]">{agent.role}</span>
        <span className="ml-auto min-w-0 truncate font-mono text-[10px] text-[var(--ink-mute)]">
          {agent.last_seen_at ? `active ${formatRelative(agent.last_seen_at)}` : "no MCP activity yet"}
        </span>
      </Card.Footer>
    </Card>
  );
}

function EmptyAgents() {
  const { address } = useWorkspace();
  const endpoint = workspaceMcpEndpoint(appUrl(), address);
  return (
    <EmptyState className="mt-5 min-h-[260px] rounded-[12px] border border-dashed border-[var(--line)] bg-[var(--paper-2)]">
      <EmptyState.Header>
        <EmptyState.Media variant="icon">
          <Bot size={18} />
        </EmptyState.Media>
        <EmptyState.Title>No agents connected yet</EmptyState.Title>
        <EmptyState.Description className="max-w-[430px]">
          Add this MCP URL in Claude Code, Cursor, Windsurf or any MCP-aware client. OAuth
          returns here to collect the agent identity and exact access.
        </EmptyState.Description>
      </EmptyState.Header>
      <EmptyState.Content>
        <Button onPress={() => void navigator.clipboard?.writeText(endpoint)} size="sm" className="gap-1.5">
          <Copy size={11} /> Copy MCP URL
        </Button>
      </EmptyState.Content>
    </EmptyState>
  );
}

/* ── Edit window (modal, provider-modal.tsx anatomy) ─────────────────── */

function AgentEditModal(props: {
  agent: AgentVM;
  capabilities: CapabilityVM[];
  bundles: BundleVM[];
  canManage: boolean;
  saving: boolean;
  onChange: (agent: AgentVM) => void;
  onSave: () => void;
  onDisconnectRequest: () => void;
  onClose: () => void;
}) {
  const { agent } = props;
  const provider = agentProviderInfo(agent);
  const patch = (next: Partial<AgentVM>) => props.onChange({ ...agent, ...next });
  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => { if (!open) props.onClose(); }} isDismissable={!props.saving}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog aria-labelledby="agent-edit-title" className="sm:max-w-[640px]">
          <Modal.CloseTrigger />
          <Modal.Header className="flex-row items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border border-[var(--line)] bg-[var(--paper-2)]">
              <ProviderLogo provider={provider} size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <Modal.Heading id="agent-edit-title" className="truncate">{props.canManage ? "Edit agent" : "Agent details"}</Modal.Heading>
              <p className="mt-0.5 truncate text-[12px] text-muted">
                {provider.name}
                {agent.client_name ? ` · ${agent.client_name}` : ""}
              </p>
            </div>
          </Modal.Header>
          <Modal.Body className="space-y-6 pb-2">
              <ModalSection title="Identity" icon={Bot}>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Name" className="col-span-2">
                    <TextField aria-label="Name" value={agent.name} isDisabled={!agent.can_edit_identity} onChange={(value) => patch({ name: value })}>
                      <Input className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-2.5 text-[12px]" />
                    </TextField>
                  </Field>
                  <Field label="Provider">
                    <Select
                      aria-label="Provider"
                      isDisabled={!agent.can_edit_identity}
                      value={agent.provider}
                      onChange={(key) => patch({ provider: (key as AgentProvider) ?? agent.provider })}
                    >
                      <Select.Trigger className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-2 text-[12px]">
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          <ListBox.Item id="codex" textValue="Codex">Codex<ListBox.ItemIndicator /></ListBox.Item>
                          <ListBox.Item id="claude_code" textValue="Claude Code">Claude Code<ListBox.ItemIndicator /></ListBox.Item>
                          <ListBox.Item id="hermes" textValue="Hermes">Hermes<ListBox.ItemIndicator /></ListBox.Item>
                          <ListBox.Item id="openclaw" textValue="OpenClaw">OpenClaw<ListBox.ItemIndicator /></ListBox.Item>
                          <ListBox.Item id="other" textValue="Other">Other<ListBox.ItemIndicator /></ListBox.Item>
                        </ListBox>
                      </Select.Popover>
                    </Select>
                  </Field>
                  <Field label="Provider label">
                    <TextField aria-label="Provider label" value={agent.provider_label ?? ""} isDisabled={!agent.can_edit_identity || agent.provider !== "other"} onChange={(value) => patch({ provider_label: value })}>
                      <Input className="h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-2.5 text-[12px] disabled:opacity-50" />
                    </TextField>
                  </Field>
                  <Field label="Description" className="col-span-2">
                    <TextField aria-label="Description" value={agent.description} isDisabled={!agent.can_edit_identity} onChange={(value) => patch({ description: value })}>
                      <TextArea className="min-h-16 w-full rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-2.5 text-[12px]" />
                    </TextField>
                  </Field>
                </div>
              </ModalSection>

              <ModalSection title="Workspace role" icon={ShieldCheck}>
                <div className="grid grid-cols-2 gap-2">
                  {(["observer", "collaborator", "operator", "custom"] as AgentRole[]).map((role) => <Button key={role} isDisabled={!props.canManage} onPress={() => patch(role === "custom" ? { role } : { role, scopes: [...ROLE_SCOPES[role]] })} variant="outline" className={`h-auto flex-col items-start rounded-md border p-3 text-left font-normal ${agent.role === role ? "border-[var(--ink)] bg-[var(--paper-2)]" : "border-[var(--line)]"}`}><span className="block text-[12px] font-medium capitalize">{role}</span><span className="mt-0.5 block text-[10.5px] leading-relaxed text-[var(--ink-3)]">{ROLE_COPY[role]}</span></Button>)}
                </div>
              </ModalSection>

              <ModalSection title="Product permissions" icon={KeyRound}>
                <div className="flex flex-wrap gap-2">{SCOPES.filter((scope) => scope !== "admin:*").map((scope) => <Button key={scope} isDisabled={!props.canManage} onPress={() => patch({ role: "custom", scopes: agent.scopes.includes(scope) ? agent.scopes.filter((item) => item !== scope) : [...agent.scopes, scope] })} variant="outline" className={`h-auto rounded-md border px-2.5 py-2 font-mono text-[10.5px] font-normal ${agent.scopes.includes(scope) ? "border-[var(--ink)] bg-[var(--paper-2)] text-[var(--ink)]" : "border-[var(--line)] text-[var(--ink-3)]"}`}>{agent.scopes.includes(scope) ? <Check size={10} className="mr-1 inline" /> : null}{scope}</Button>)}</div>
              </ModalSection>

              <ModalSection title="Capabilities" icon={Terminal}>
                {props.bundles.length > 0 ? <ChoiceList title="Bundles" items={props.bundles.map((item) => ({ id: item.id, label: item.title, meta: "bundle" }))} selected={agent.bundle_ids} onSelectionChange={(ids) => patch({ bundle_ids: ids })} disabled={!props.canManage} /> : null}
                {props.capabilities.length > 0 ? <ChoiceList title="Individual tools" items={props.capabilities.map((item) => ({ id: item.id, label: item.title, meta: `${item.provider} · ${item.type}` }))} selected={agent.capability_ids} onSelectionChange={(ids) => patch({ capability_ids: ids })} disabled={!props.canManage} /> : <p className="text-[11.5px] text-[var(--ink-3)]">No approved tool providers yet. Add MCP servers or workflows from Tool providers.</p>}
              </ModalSection>

              <div className="rounded-[10px] border border-[var(--line)] bg-[var(--paper-2)] p-3 font-mono text-[10.5px] text-[var(--ink-3)]">
                {agent.workspace_count} workspace{agent.workspace_count === 1 ? "" : "s"} · {agent.session_count} active session{agent.session_count === 1 ? "" : "s"} · last seen {formatLastSeen(agent.last_seen_at)}
              </div>
          </Modal.Body>
          <Modal.Footer className="flex items-center gap-2">
            {props.canManage ? (
              <Button onPress={props.onDisconnectRequest} isDisabled={props.saving} variant="ghost" size="sm" className="gap-1.5 text-danger hover:bg-danger/5"><Unplug size={13} /> Disconnect</Button>
            ) : null}
            <span className="ml-auto" />
            <Button onPress={props.onClose} isDisabled={props.saving} variant="outline" size="sm">Cancel</Button>
            {props.canManage ? (
              <Button onPress={props.onSave} isDisabled={props.saving || agent.scopes.length === 0} size="sm" className="gap-1.5"><Check size={12} />{props.saving ? "Saving…" : "Save access"}</Button>
            ) : null}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function DisconnectAgentDialog({ agent, saving, onClose, onConfirm }: {
  agent: AgentVM;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Backdrop isOpen onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <AlertDialog.Container placement="center">
        <AlertDialog.Dialog aria-labelledby="disconnect-agent-title" className="w-full max-w-[440px]">
          <AlertDialog.Header className="flex-col items-start gap-0">
            <AlertDialog.Icon status="danger">
              <Unplug size={15} />
            </AlertDialog.Icon>
            <AlertDialog.Heading id="disconnect-agent-title" className="mt-4 text-[15px] font-medium">Disconnect {agent.name}?</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted">Its access to this workspace is revoked immediately: tokens stop working, sessions end and tool grants are removed. The agent can reconnect later through OAuth or a new token, but this cannot be undone for the current connection.</p>
          </AlertDialog.Body>
          <AlertDialog.Footer className="flex">
            <Button isDisabled={saving} onPress={onClose} variant="outline" size="sm">Cancel</Button>
            <Button isDisabled={saving} onPress={onConfirm} variant="danger" size="sm" className="ml-auto gap-1.5"><Unplug size={11} />{saving ? "Disconnecting…" : "Disconnect agent"}</Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function ChoiceList({ title, items, selected, onSelectionChange, disabled }: { title: string; items: Array<{ id: string; label: string; meta: string }>; selected: string[]; onSelectionChange: (ids: string[]) => void; disabled: boolean }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.05em] text-[var(--ink-mute)]">{title}</div>
      <CheckboxButtonGroup aria-label={title} value={selected} onChange={onSelectionChange} isDisabled={disabled} className="gap-1.5">
        {items.map((item) => (
          <CheckboxButtonGroup.Item key={item.id} value={item.id} className="rounded-md px-3 py-2">
            <CheckboxButtonGroup.Indicator />
            <CheckboxButtonGroup.ItemContent className="flex-row items-center justify-between gap-2">
              <span className="text-[11.5px]">{item.label}</span>
              <span className="font-mono text-[9.5px] text-[var(--ink-mute)]">{item.meta}</span>
            </CheckboxButtonGroup.ItemContent>
          </CheckboxButtonGroup.Item>
        ))}
      </CheckboxButtonGroup>
    </div>
  );
}

function ModalSection({ title, icon: Icon, children }: { title: string; icon: typeof Bot; children: React.ReactNode }) { return <section><h4 className="mb-3 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--ink-mute)]"><Icon size={11} />{title}</h4>{children}</section>; }
function Field({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) { return <label className={`flex flex-col gap-1.5 text-[10.5px] text-[var(--ink-3)] ${className}`}>{label}{children}</label>; }
function connectionState(lastSeen: string | null): { key: ConnectionStateKey; label: string; color: string } {
  if (!lastSeen) return { key: "never", label: "never", color: "var(--ink-mute)" };
  const age = Date.now() - Date.parse(lastSeen);
  if (age < 15 * 60_000) return { key: "active", label: "active", color: "var(--success)" };
  if (age < 7 * 86_400_000) return { key: "recent", label: "recent", color: "var(--warning)" };
  return { key: "stale", label: "stale", color: "var(--ink-mute)" };
}
function formatLastSeen(value: string | null) { if (!value) return "never"; return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
