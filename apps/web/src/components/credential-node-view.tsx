"use client";

/**
 * Rendering/editing surface for `kind === "credential"` nodes.
 *
 * ONE node is ONE credential — one platform, one environment, one key. The
 * shape lives in `node.data` (see `@bcontext-dev/contract/credentials`): a
 * `credential` block that says which credential this is (type, environment,
 * service) and a `fields` array that holds the values. `fields` is the only
 * home for secret material; `content_md` is a human note at most.
 *
 * The type picks a template of slots, so an API key asks for an API key and
 * an SSH key asks for a private key and a host, instead of every credential
 * being an untitled bag of name/value pairs. Retyping never drops data: a
 * field no slot claims moves to "Other fields", and `custom` is the escape
 * hatch that is all "other fields".
 *
 * Two renderings on the same form:
 *   - `CredentialNodeView` — full surface (the `/n/<id>` page) or `compact`
 *     (the floating node panel, which is where it is normally read).
 *   - `CredentialCard` — read-only summary + fields for the credentials view.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Chip,
  Input,
  ListBox,
  Select,
  TextArea,
  TextField,
  Tooltip,
} from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { Check, Copy, Eye, EyeOff, KeyRound, Pencil, Plus, Terminal, Trash2, X } from "lucide-react";
import { useToast, useWorkspace } from "@/components/workspace-context";
import { newestUpdatedAt } from "@/lib/newest-updated-at";
import {
  CREDENTIAL_ENVIRONMENTS,
  CREDENTIAL_ENVIRONMENT_LABELS,
  CREDENTIAL_TYPES,
  credentialEnvName,
  credentialRef,
  credentialSlotViews,
  credentialTypeDef,
  missingCredentialSlots,
  readCredential,
  writeCredential,
  type Credential,
  type CredentialEnvironment,
  type CredentialField,
  type CredentialTypeId,
} from "@bcontext-dev/contract/credentials";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { cn } from "@bcontext-dev/contract/utils";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

export type { CredentialField };

const ENV_TONE: Record<CredentialEnvironment, string> = {
  local: "text-[var(--ink-3)] border-[var(--line)]",
  dev: "text-[#5f83c7] border-[#5f83c7]/40",
  staging: "text-[#d99a3d] border-[#d99a3d]/40",
  prod: "text-[#d46464] border-[#d46464]/50",
};

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** Type + environment + service, the three things that say which credential this is. */
export function CredentialIdentity({
  credential,
  className,
}: {
  credential: Credential;
  className?: string;
}) {
  const def = credentialTypeDef(credential.type);
  const missing = missingCredentialSlots(credential);
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <Chip size="sm" variant="soft" className="rounded px-1.5 py-0.5 text-[10.5px] text-[var(--ink-2)]">
        <Chip.Label>{def.label}</Chip.Label>
      </Chip>
      {credential.environment ? (
        <span
          className={cn(
            "mono rounded border px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider",
            ENV_TONE[credential.environment],
          )}
        >
          {CREDENTIAL_ENVIRONMENT_LABELS[credential.environment]}
        </span>
      ) : null}
      {credential.service ? (
        <span className="truncate text-[11.5px] text-[var(--ink-3)]">{credential.service}</span>
      ) : null}
      {missing.length > 0 ? (
        <span className="mono rounded border border-[var(--line)] px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider text-[var(--ink-mute)]">
          {missing.length} missing
        </span>
      ) : null}
    </div>
  );
}

/** One field row: label, masked value, reveal, copy, and (when editable) edit/remove. */
function FieldRow({
  label,
  value,
  secret,
  multiline,
  help,
  envName,
  ref_,
  editable,
  saving,
  onEdit,
  onRemove,
}: {
  label: string;
  value: string;
  secret: boolean;
  multiline?: boolean;
  help?: string;
  envName: string;
  ref_: string | null;
  editable: boolean;
  saving: boolean;
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  const toast = useToast();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<"value" | "ref" | null>(null);
  const shown = !secret || revealed;
  const empty = !value;

  const copy = async (what: "value" | "ref", text: string) => {
    if (await copyToClipboard(text)) {
      setCopied(what);
      toast.info(what === "ref" ? "Reference copied." : "Copied to clipboard", { duration: 1500 });
      setTimeout(() => setCopied((current) => (current === what ? null : current)), 1200);
    } else {
      toast.error("Couldn’t copy — clipboard unavailable.");
    }
  };

  return (
    <li className="flex items-start gap-2 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-2">
      <div className="w-[38%] min-w-0 shrink-0">
        <span className="block truncate text-[11.5px] font-medium text-[var(--ink-2)]">{label}</span>
        {help ? <span className="block truncate text-[10px] text-[var(--ink-mute)]">{help}</span> : null}
      </div>
      <span
        className={cn(
          "mono min-w-0 flex-1 text-[12px] text-[var(--ink)]",
          multiline && shown && !empty ? "line-clamp-3 break-all" : "truncate",
          empty ? "text-[var(--ink-mute)]" : "",
        )}
      >
        {empty ? "—" : shown ? value : "••••••••"}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        {secret && !empty ? (
          <IconAction label={revealed ? `Hide ${label}` : `Reveal ${label}`} onPress={() => setRevealed((open) => !open)}>
            {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
          </IconAction>
        ) : null}
        {!empty ? (
          <IconAction label={`Copy ${label}`} onPress={() => void copy("value", value)}>
            {copied === "value" ? <Check size={13} /> : <Copy size={13} />}
          </IconAction>
        ) : null}
        {ref_ ? (
          <IconAction
            label={`Copy the shell line for ${label} (${envName})`}
            onPress={() => void copy("ref", ref_)}
          >
            {copied === "ref" ? <Check size={13} /> : <Terminal size={13} />}
          </IconAction>
        ) : null}
        {editable ? (
          <IconAction label={`Edit ${label}`} disabled={saving} onPress={() => onEdit?.()}>
            <Pencil size={13} />
          </IconAction>
        ) : null}
        {editable && onRemove ? (
          <IconAction label={`Remove ${label}`} disabled={saving} onPress={onRemove} danger>
            <Trash2 size={13} />
          </IconAction>
        ) : null}
      </div>
    </li>
  );
}

function IconAction({
  label,
  onPress,
  disabled = false,
  danger = false,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip delay={500}>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        isDisabled={disabled}
        aria-label={label}
        onPress={onPress}
        className={cn("icon-btn", danger ? "text-[var(--danger,#c0392b)]" : "")}
      >
        {children}
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}

function FieldEditor({
  label,
  value,
  secret,
  multiline,
  placeholder,
  nameEditable,
  onLabelChange,
  onValueChange,
  onCommit,
  onCancel,
}: {
  label: string;
  value: string;
  secret: boolean;
  multiline?: boolean;
  placeholder?: string;
  nameEditable: boolean;
  onLabelChange: (value: string) => void;
  onValueChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-[var(--line-strong)] bg-[var(--paper-2)] p-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        {nameEditable ? (
          <TextField aria-label="Field name" value={label} onChange={onLabelChange} className="sm:w-[38%]">
            <Input placeholder="Field name" className="mono text-[12px]" />
          </TextField>
        ) : (
          <span className="pt-1.5 text-[11.5px] font-medium text-[var(--ink-2)] sm:w-[38%]">
            {label}
            {secret ? <span className="ml-1 text-[10px] text-[var(--ink-mute)]">secret</span> : null}
          </span>
        )}
        <TextField aria-label={`${label} value`} value={value} onChange={onValueChange} className="flex-1">
          {multiline ? (
            <TextArea
              autoFocus
              rows={5}
              placeholder={placeholder}
              className="mono w-full resize-y rounded-md border border-[var(--line)] bg-[var(--paper)] p-2 text-[12px] outline-none focus:border-[var(--line-strong)]"
            />
          ) : (
            <Input
              autoFocus
              placeholder={placeholder}
              className="mono text-[12px]"
              onKeyDown={(event) => {
                if (event.key === "Enter") onCommit();
                if (event.key === "Escape") onCancel();
              }}
            />
          )}
        </TextField>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" onPress={onCancel} className="text-[11px]">
          <X size={11} /> Cancel
        </Button>
        <Button variant="primary" size="sm" isDisabled={!label.trim()} onPress={onCommit} className="text-[11px]">
          <Check size={11} /> Save
        </Button>
      </div>
    </li>
  );
}

interface EditState {
  /** Slot key, or the index of an extra field, or `null` for a new field. */
  target: { kind: "slot"; key: string } | { kind: "extra"; index: number } | { kind: "new" };
  label: string;
  value: string;
  secret: boolean;
  multiline: boolean;
  placeholder?: string;
}

/**
 * The credential itself: its slots in the type's order, then whatever fields
 * no slot claims, then (when editable) a way to add one.
 */
export function CredentialBody({
  credential,
  nodeId,
  nodeTitle,
  editable = false,
  saving = false,
  onChange,
}: {
  credential: Credential;
  nodeId: string;
  nodeTitle?: string;
  editable?: boolean;
  saving?: boolean;
  onChange?: (next: Credential) => void;
}) {
  const [edit, setEdit] = useState<EditState | null>(null);
  const { slots, extra } = useMemo(() => credentialSlotViews(credential), [credential]);

  const commit = () => {
    if (!edit || !onChange) return;
    const label = edit.label.trim();
    if (!label) return;
    const fields = [...credential.fields];
    if (edit.target.kind === "slot") {
      const key = edit.target.key;
      const at = slots.find((slot) => slot.key === key)?.index ?? -1;
      const next: CredentialField = { key, name: label, value: edit.value, secret: edit.secret };
      if (at >= 0) fields[at] = next;
      else fields.push(next);
    } else if (edit.target.kind === "extra") {
      fields[edit.target.index] = { ...fields[edit.target.index]!, name: label, value: edit.value };
    } else {
      fields.push({ key: null, name: label, value: edit.value, secret: edit.secret });
    }
    onChange({ ...credential, fields });
    setEdit(null);
  };

  const removeAt = (index: number) => {
    if (!onChange || index < 0) return;
    onChange({ ...credential, fields: credential.fields.filter((_, i) => i !== index) });
    setEdit(null);
  };

  // A read-only card shows what the credential HAS. An empty optional slot is
  // an invitation to fill it in, which only makes sense where you can: in the
  // editor. Required ones stay visible either way — a missing required field
  // is information.
  const visibleSlots = editable ? slots : slots.filter((slot) => slot.value.trim() || slot.required);

  const rows = [
    ...visibleSlots.map((slot) => ({
      id: `slot:${slot.key}`,
      label: slot.label,
      value: slot.value,
      secret: slot.secret,
      multiline: slot.multiline,
      placeholder: slot.placeholder,
      help: slot.help,
      key: slot.key,
      index: slot.index,
      nameEditable: false,
      editTarget: { kind: "slot" as const, key: slot.key },
    })),
    ...extra.map((field) => ({
      id: `extra:${field.index}`,
      label: field.name,
      value: field.value,
      secret: field.secret,
      multiline: false,
      placeholder: undefined,
      help: undefined,
      key: field.key,
      index: field.index,
      nameEditable: true,
      editTarget: { kind: "extra" as const, index: field.index },
    })),
  ];

  if (rows.length === 0 && !edit) {
    return (
      <div className="flex flex-col gap-2">
        <EmptyState size="sm">
          <EmptyState.Header>
            <EmptyState.Media variant="icon">
              <KeyRound />
            </EmptyState.Media>
            <EmptyState.Title>No fields yet</EmptyState.Title>
            <EmptyState.Description>
              Pick a type above to get the right fields, or add your own.
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
        {editable ? <AddFieldButton saving={saving} onPress={() => setEdit(newFieldState())} /> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex list-none flex-col gap-1.5 p-0">
        {rows.map((row) =>
          edit &&
          ((edit.target.kind === "slot" && row.editTarget.kind === "slot" && edit.target.key === row.editTarget.key) ||
            (edit.target.kind === "extra" && row.editTarget.kind === "extra" && edit.target.index === row.editTarget.index)) ? (
            <FieldEditor
              key={row.id}
              label={edit.label}
              value={edit.value}
              secret={edit.secret}
              multiline={edit.multiline}
              placeholder={edit.placeholder}
              nameEditable={row.nameEditable}
              onLabelChange={(label) => setEdit({ ...edit, label })}
              onValueChange={(value) => setEdit({ ...edit, value })}
              onCommit={commit}
              onCancel={() => setEdit(null)}
            />
          ) : (
            <FieldRow
              key={row.id}
              label={row.label}
              value={row.value}
              secret={row.secret}
              multiline={row.multiline}
              help={row.help}
              envName={credentialEnvName(credential, { key: row.key, name: row.label }, nodeTitle ?? "")}
              ref_={row.key ? credentialRef(nodeId, row.key) : null}
              editable={editable}
              saving={saving}
              onEdit={() =>
                setEdit({
                  target: row.editTarget,
                  label: row.label,
                  value: row.value,
                  secret: row.secret,
                  multiline: Boolean(row.multiline),
                  placeholder: row.placeholder,
                })
              }
              onRemove={row.index >= 0 ? () => removeAt(row.index) : undefined}
            />
          ),
        )}
        {edit && edit.target.kind === "new" ? (
          <FieldEditor
            label={edit.label}
            value={edit.value}
            secret={edit.secret}
            multiline={false}
            nameEditable
            onLabelChange={(label) => setEdit({ ...edit, label })}
            onValueChange={(value) => setEdit({ ...edit, value })}
            onCommit={commit}
            onCancel={() => setEdit(null)}
          />
        ) : null}
      </ul>
      {editable && !edit ? <AddFieldButton saving={saving} onPress={() => setEdit(newFieldState())} /> : null}
    </div>
  );
}

function newFieldState(): EditState {
  return { target: { kind: "new" }, label: "", value: "", secret: true, multiline: false };
}

function AddFieldButton({ saving, onPress }: { saving: boolean; onPress: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      isDisabled={saving}
      onPress={onPress}
      className="mono inline-flex items-center gap-1.5 self-start rounded-md border border-dashed border-[var(--line)] px-2.5 py-1.5 text-[10.5px] uppercase tracking-wide text-[var(--ink-3)]"
    >
      <Plus size={11} /> Add field
    </Button>
  );
}

function MetaSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      aria-label={label}
      isDisabled={disabled}
      value={value}
      onChange={(key) => onChange(key == null ? "" : String(key))}
      className="min-w-0"
    >
      <Select.Trigger className="inline-flex h-7 max-w-full items-center gap-1.5 overflow-hidden rounded-full border border-[var(--line)] bg-[var(--paper)] py-0 pl-2.5 pr-1.5 text-[11.5px] leading-none text-[var(--ink)] hover:border-[var(--line-strong)]">
        <span className="shrink-0 text-[var(--ink-mute)]">{label}</span>
        <Select.Value className="min-w-0 truncate font-medium" />
        <Select.Indicator className="shrink-0 opacity-60" />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
              <span className="truncate">{option.label}</span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export interface CredentialNodeViewProps {
  workspace: WorkspaceAddress;
  nodeId: string;
  nodeTitle?: string;
  initialData: Record<string, unknown>;
  /** The node's `updated_at` as rendered — the optimistic lock's fallback seed. */
  initialUpdatedAt?: string;
  header?: React.ReactNode;
  /** Compact rendering for the floating node panel — no title editor. */
  compact?: boolean;
  /** Read-only access shows the fields (masked, copyable) without any editing. */
  canWrite?: boolean;
  /** The server's node after a confirmed write, for a parent that keeps its own copy. */
  onWritten?: (node: KnowledgeNode) => void;
}

export function CredentialNodeView({
  workspace,
  nodeId,
  nodeTitle,
  initialData,
  initialUpdatedAt,
  header,
  compact = false,
  canWrite = true,
  onWritten,
}: CredentialNodeViewProps) {
  const { nodes, patchNodeSummary, toast } = useWorkspace();
  const [data, setData] = useState<Record<string, unknown>>(initialData ?? {});
  const [title, setTitle] = useState(nodeTitle ?? "");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [serviceDraft, setServiceDraft] = useState<string | null>(null);
  // Every write here replaces the whole `data` column, so it must be guarded:
  // `if_updated_at` is the freshest value this client knows — the workspace
  // overlay (confirmed writes, peers' broadcasts) first, the render's seed
  // otherwise — and a 409 re-reads the node instead of overwriting it.
  const [seenUpdatedAt, setSeenUpdatedAt] = useState(initialUpdatedAt);
  const updatedAt = newestUpdatedAt(
    nodes.find((candidate) => candidate.id === nodeId)?.updated_at,
    initialUpdatedAt,
    seenUpdatedAt,
  );

  // A newer render (the panel reloaded after a peer's write) replaces the
  // fields; keyed on `updated_at` so a stale page prop never undoes a save.
  const syncedRef = useRef(initialUpdatedAt);
  useEffect(() => {
    if (initialUpdatedAt === syncedRef.current || saving) return;
    syncedRef.current = initialUpdatedAt;
    setData(initialData ?? {});
  }, [initialData, initialUpdatedAt, saving]);

  const credential = useMemo(() => readCredential(data), [data]);

  /** Fold a confirmed node into local state and the workspace overlay. */
  const fold = (current: KnowledgeNode) => {
    setSeenUpdatedAt(current.updated_at);
    syncedRef.current = current.updated_at;
    patchNodeSummary(nodeId, { title: current.title, data: current.data, updated_at: current.updated_at });
    onWritten?.(current);
  };

  /** After a 409: show what is stored, so the next edit starts from it. */
  const reload = async () => {
    try {
      const response = await fetch(
        `/api/nodes/${encodeURIComponent(nodeId)}?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const body = (await response.json()) as { node?: KnowledgeNode };
      if (!body.node) return;
      setData(body.node.data ?? {});
      setTitle(body.node.title);
      setTitleDraft(body.node.title);
      fold(body.node);
    } catch {
      // The toast already said the node moved on; a failed re-read just
      // means the next save 409s again, which is the safe outcome.
    }
  };

  const persist = async (next: Credential) => {
    const previous = data;
    // Spread over the current data: the credential shape owns `credential`
    // and `fields`, but the column also carries keys nobody here edits
    // (`previous_slugs`, mentions…) that a wholesale write would drop.
    const nextData = { ...data, ...writeCredential(next) };
    setData(nextData);
    setSaving(true);
    try {
      const response = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: workspaceApiRef(workspace),
          ...(updatedAt ? { if_updated_at: updatedAt } : {}),
          data: nextData,
        }),
      });
      if (response.status === 409) {
        setData(previous);
        await reload();
        toast.error("This credential changed elsewhere. Showing the stored version — edit again.");
        return;
      }
      if (!response.ok) throw new Error("save failed");
      const body = (await response.json()) as { node?: KnowledgeNode };
      if (body.node) fold(body.node);
    } catch {
      setData(previous);
      toast.error("Couldn’t save the credential.");
    } finally {
      setSaving(false);
    }
  };

  const persistTitle = async () => {
    const next = titleDraft.trim();
    if (!next || next === title) {
      setEditingTitle(false);
      setTitleDraft(title);
      return;
    }
    const previous = title;
    setTitle(next);
    setEditingTitle(false);
    setSaving(true);
    try {
      const response = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: workspaceApiRef(workspace),
          ...(updatedAt ? { if_updated_at: updatedAt } : {}),
          title: next,
        }),
      });
      if (response.status === 409) {
        setTitle(previous);
        await reload();
        toast.error("This credential changed elsewhere. Showing the stored version — rename again.");
        return;
      }
      if (!response.ok) throw new Error("save failed");
      const body = (await response.json()) as { node?: KnowledgeNode };
      if (body.node) fold(body.node);
    } catch {
      setTitle(previous);
      toast.error("Couldn’t rename the credential.");
    } finally {
      setSaving(false);
    }
  };

  const controls = (
    <div className="flex flex-wrap items-center gap-1.5">
      <MetaSelect
        label="Type"
        value={credential.type}
        disabled={saving || !canWrite}
        options={CREDENTIAL_TYPES.map((type) => ({ value: type.id, label: type.label }))}
        onChange={(value) => void persist({ ...credential, type: (value || "custom") as CredentialTypeId })}
      />
      <MetaSelect
        label="Env"
        value={credential.environment ?? ""}
        disabled={saving || !canWrite}
        options={[
          { value: "", label: "Not set" },
          ...CREDENTIAL_ENVIRONMENTS.map((env) => ({ value: env, label: CREDENTIAL_ENVIRONMENT_LABELS[env] })),
        ]}
        onChange={(value) =>
          void persist({ ...credential, environment: (value || null) as CredentialEnvironment | null })
        }
      />
      <TextField
        aria-label="Service"
        value={serviceDraft ?? credential.service ?? ""}
        onChange={setServiceDraft}
        isReadOnly={!canWrite}
        className="w-[150px]"
      >
        <Input
          placeholder="Service"
          className="h-7 rounded-full text-[11.5px]"
          onBlur={() => {
            const next = (serviceDraft ?? "").trim();
            setServiceDraft(null);
            if (serviceDraft !== null && next !== (credential.service ?? "")) {
              void persist({ ...credential, service: next || null });
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setServiceDraft(null);
              event.currentTarget.blur();
            }
          }}
        />
      </TextField>
    </div>
  );

  const body = (
    <CredentialBody
      credential={credential}
      nodeId={nodeId}
      nodeTitle={title || nodeTitle}
      editable={canWrite}
      saving={saving}
      onChange={(next) => void persist(next)}
    />
  );

  if (compact) {
    return (
      <div className="flex flex-col gap-3">
        {controls}
        {body}
        <p className="text-[10.5px] leading-relaxed text-[var(--ink-mute)]">
          Values stay here: agents read this credential’s shape, never its values, and use it through
          the reference on each field. One node is one credential — a second platform or a second
          environment is a second node.
        </p>
      </div>
    );
  }

  return (
    <div className="scroll relative h-full overflow-y-auto bg-[var(--paper)]">
      <div
        className="mx-auto flex flex-col gap-4"
        style={{
          maxWidth: "var(--edit-max-wide, 1280px)",
          paddingInline: "var(--editor-px)",
          paddingBlock: "var(--editor-py)",
          paddingBottom: "120px",
        }}
      >
        {header}

        <div className="flex items-center gap-2">
          <KeyRound size={16} className="shrink-0 text-[var(--ink-3)]" aria-hidden />
          {editingTitle ? (
            <TextField aria-label="Credential title" value={titleDraft} onChange={setTitleDraft} className="flex-1">
              <Input
                autoFocus
                onBlur={() => void persistTitle()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void persistTitle();
                  if (event.key === "Escape") {
                    setTitleDraft(title);
                    setEditingTitle(false);
                  }
                }}
                className="text-[15px] font-medium"
              />
            </TextField>
          ) : (
            <button
              type="button"
              onClick={() => {
                setTitleDraft(title);
                setEditingTitle(true);
              }}
              className="rounded-md px-1.5 py-1 text-left text-[15px] font-medium text-[var(--ink)] hover:bg-[var(--paper-3)]"
            >
              {title || "Untitled credential"}
            </button>
          )}
        </div>

        {controls}

        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-2)] p-3">{body}</div>
      </div>
    </div>
  );
}
