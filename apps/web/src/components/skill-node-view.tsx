"use client";

/**
 * Rendering/editing surface for `kind === "skill"` nodes — the floating
 * panel (`node-panel/panel-body.tsx`, `compact`) and the `/n/<id>` page
 * (`lazy-node-body.tsx`).
 *
 * A skill is a typed prompt template: a YAML frontmatter block (title,
 * model pin, declared inputs, system prompt — `src/lib/skills/frontmatter.ts`
 * reads it) followed by the prompt with `{{var}}` placeholders. The header
 * shows what the frontmatter declares, and the version the API keeps on
 * `data.version` (bumped on every body change, whichever door it comes
 * through).
 *
 * The body is edited as SOURCE, in a plain text area, never in the rich
 * editor: TipTap's Markdown round trip turns the `---` fences into rules
 * and setext headings and flattens the indented YAML, which destroys the
 * schema `skills_run` validates against. Saving is a guarded
 * `PATCH /api/nodes/:id { content_md }` with `if_updated_at` — optimistic
 * on the rendered source, reverted with a toast if the API refuses,
 * re-read on a 409 — and the confirmed node is folded into the workspace
 * overlay and handed to `onWritten` for a parent that keeps its own copy.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Chip, TextArea } from "@heroui/react";
import { Check, ChevronDown, ChevronRight, Cpu, Pencil, Wand2, X } from "lucide-react";
import { useToast, useWorkspace } from "@/components/workspace-context";
import { parseSkillBody, type SkillInputField } from "@/lib/skills/frontmatter";
import { newestUpdatedAt } from "@/lib/newest-updated-at";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { cn } from "@bcontext-dev/contract/utils";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

/** Integer version stored on the node; unversioned skills count as v1 (the API's rule). */
export function skillVersion(data: Record<string, unknown> | null | undefined): number {
  const value = data?.version;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}

export interface SkillNodeViewProps {
  workspace: WorkspaceAddress;
  nodeId: string;
  nodeTitle?: string;
  initialMarkdown: string;
  initialData: Record<string, unknown>;
  /** The node's `updated_at` as rendered — the optimistic lock's fallback seed. */
  initialUpdatedAt?: string;
  canWrite?: boolean;
  /** Each confirmed write's node, for a parent that keeps its own copy. */
  onWritten?: (node: KnowledgeNode) => void;
  header?: React.ReactNode;
  /** Compact rendering for the floating node panel — no page column. */
  compact?: boolean;
}

export function SkillNodeView({
  workspace,
  nodeId,
  initialMarkdown,
  initialData,
  initialUpdatedAt,
  canWrite = true,
  onWritten,
  header,
  compact = false,
}: SkillNodeViewProps) {
  const { nodes, patchNodeSummary } = useWorkspace();
  const toast = useToast();
  const [source, setSource] = useState(initialMarkdown);
  const [data, setData] = useState(initialData ?? {});
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const [seenUpdatedAt, setSeenUpdatedAt] = useState(initialUpdatedAt);
  const updatedAt = newestUpdatedAt(
    nodes.find((candidate) => candidate.id === nodeId)?.updated_at,
    initialUpdatedAt,
    seenUpdatedAt,
  );

  // A newer render of the node (the panel reloaded, the page refreshed)
  // replaces what is shown unless the person is mid-edit: their draft wins
  // until they save or cancel, and the conflict guard settles the rest.
  const syncedRef = useRef(initialUpdatedAt);
  useEffect(() => {
    if (initialUpdatedAt === syncedRef.current || draft !== null || saving) return;
    syncedRef.current = initialUpdatedAt;
    setSource(initialMarkdown);
    setData(initialData ?? {});
  }, [initialMarkdown, initialData, initialUpdatedAt, draft, saving]);

  const parsed = useMemo(() => parseSkillBody(source), [source]);
  const fm = parsed.frontmatter;
  const version = skillVersion(data);

  const fold = (current: KnowledgeNode) => {
    setSeenUpdatedAt(current.updated_at);
    syncedRef.current = current.updated_at;
    setSource(current.content_md);
    setData(current.data ?? {});
    patchNodeSummary(nodeId, { data: current.data, updated_at: current.updated_at });
    onWritten?.(current);
  };

  const reload = async () => {
    try {
      const response = await fetch(
        `/api/nodes/${encodeURIComponent(nodeId)}?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const body = (await response.json()) as { node?: KnowledgeNode };
      if (body.node) fold(body.node);
    } catch {
      // The toast already said the skill moved on; a failed re-read just
      // means the next save 409s again, which is the safe outcome.
    }
  };

  const save = async () => {
    if (draft === null) return;
    const next = draft;
    const previous = source;
    if (next === previous) {
      setDraft(null);
      return;
    }
    setSource(next);
    setDraft(null);
    setSaving(true);
    try {
      const response = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: workspaceApiRef(workspace),
          ...(updatedAt ? { if_updated_at: updatedAt } : {}),
          content_md: next,
        }),
      });
      if (response.status === 409) {
        setSource(previous);
        await reload();
        toast.error("This skill changed elsewhere. Showing the stored version — edit again.");
        return;
      }
      if (!response.ok) throw new Error("save failed");
      const body = (await response.json()) as { node?: KnowledgeNode };
      if (body.node) fold(body.node);
    } catch {
      setSource(previous);
      toast.error("Couldn’t save the skill.");
    } finally {
      setSaving(false);
    }
  };

  const editing = draft !== null;

  const identity = (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip size="sm" variant="soft" className="mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--ink-2)]">
        <Chip.Label>v{version}</Chip.Label>
      </Chip>
      {fm.name ? (
        <span className="mono text-[11px] text-[var(--ink-3)]">{fm.name}</span>
      ) : null}
      {fm.model ? (
        <span className="mono inline-flex items-center gap-1 rounded border border-[var(--line)] px-1.5 py-0.5 text-[9.5px] text-[var(--ink-3)]" title="Model pinned by the skill">
          <Cpu size={9} /> {fm.model}
        </span>
      ) : null}
      {fm.scopes?.map((scope) => (
        <span key={scope} className="mono rounded border border-[var(--line)] px-1.5 py-0.5 text-[9.5px] text-[var(--ink-mute)]">
          {scope}
        </span>
      ))}
      <span className="ml-auto" />
      {canWrite && !editing ? (
        <Button
          size="sm"
          variant="ghost"
          isDisabled={saving}
          onPress={() => setDraft(source)}
          className="h-7 gap-1.5 text-[11.5px] text-[var(--ink-2)]"
        >
          <Pencil size={11} /> Edit source
        </Button>
      ) : null}
    </div>
  );

  const declared = (
    <div className="flex flex-col gap-3">
      {fm.description ? (
        <p className="text-[12.5px] leading-relaxed text-[var(--ink-2)]">{fm.description}</p>
      ) : null}
      {!parsed.hasFrontmatter ? (
        <p className="text-[11.5px] leading-relaxed text-[var(--ink-mute)]">
          No frontmatter: this skill declares no inputs, so it runs as a plain prompt. Add a{" "}
          <span className="mono">---</span> block with <span className="mono">input_schema.fields</span> to type it.
        </p>
      ) : null}
      <InputFields fields={fm.fields} />
      {fm.tools && fm.tools.length > 0 ? (
        <div>
          <h3 className="mono mb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">Tools</h3>
          <ol className="flex flex-col gap-0.5 text-[11.5px] text-[var(--ink-2)]">
            {fm.tools.map((tool, index) => (
              <li key={`${tool.name}-${index}`} className="flex items-baseline gap-2">
                <span className="mono text-[10px] text-[var(--ink-mute)]">{index + 1}</span>
                <span className="mono">{tool.name}{tool.op ? `(${tool.op})` : ""}</span>
                {tool.when ? <span className="text-[var(--ink-3)]">when {tool.when}</span> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {fm.system ? (
        <div>
          <button
            type="button"
            onClick={() => setSystemOpen((open) => !open)}
            aria-expanded={systemOpen}
            className="mono inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-mute)] hover:text-[var(--ink)]"
          >
            {systemOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />} System prompt
          </button>
          {systemOpen ? (
            <pre className="mono mt-1 whitespace-pre-wrap rounded-md bg-[var(--paper-3)] p-2.5 text-[11.5px] leading-relaxed text-[var(--ink-2)]">{fm.system.trimEnd()}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const prompt = editing ? (
    <div className="flex flex-col gap-2" data-testid="skill-source-editor">
      <TextArea
        aria-label="Skill source"
        value={draft ?? ""}
        onChange={(event) => setDraft(event.target.value)}
        fullWidth
        rows={compact ? 18 : 28}
        className="mono w-full text-[12px] leading-relaxed"
        onKeyDown={(event) => {
          if (event.key === "Escape") setDraft(null);
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void save();
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10.5px] text-[var(--ink-mute)]">
          Frontmatter and prompt together — the version bumps when the text changes.
        </span>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" isDisabled={saving} onPress={() => setDraft(null)} className="h-7 gap-1 text-[11.5px]">
            <X size={11} /> Cancel
          </Button>
          <Button size="sm" variant="primary" isDisabled={saving} onPress={() => void save()} className="h-7 gap-1 text-[11.5px]">
            <Check size={11} /> Save
          </Button>
        </div>
      </div>
    </div>
  ) : (
    <div>
      <h3 className="mono mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">
        <Wand2 size={10} /> Prompt
      </h3>
      {parsed.body.trim() ? (
        <pre className="mono whitespace-pre-wrap rounded-md border border-[var(--line)] bg-[var(--paper)] p-3 text-[12px] leading-relaxed text-[var(--ink)]">
          <Placeholders text={parsed.body.trimEnd()} known={fm.fields.map((field) => field.name)} />
        </pre>
      ) : (
        <p className="text-[12px] text-[var(--ink-3)]">No prompt yet.</p>
      )}
    </div>
  );

  if (compact) {
    return (
      <div className="flex flex-col gap-4">
        {identity}
        {editing ? null : declared}
        {prompt}
      </div>
    );
  }

  return (
    <div className="scroll relative h-full overflow-y-auto bg-[var(--paper)]">
      <div
        className="mx-auto flex flex-col gap-4"
        style={{
          maxWidth: "var(--edit-max, 920px)",
          paddingInline: "var(--editor-px)",
          paddingBlock: "var(--editor-py)",
          paddingBottom: "120px",
        }}
      >
        {header}
        {identity}
        {editing ? null : <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-2)] p-3">{declared}</div>}
        {prompt}
      </div>
    </div>
  );
}

/** The declared inputs as a compact table: name, type, required, default. */
function InputFields({ fields }: { fields: SkillInputField[] }) {
  if (fields.length === 0) return null;
  return (
    <div>
      <h3 className="mono mb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-mute)]">Inputs</h3>
      <ul className="flex flex-col gap-1">
        {fields.map((field) => (
          <li key={field.name} className="flex flex-col gap-0.5 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="mono text-[12px] text-[var(--ink)]">{`{{${field.name}}}`}</span>
              <span className="mono text-[10px] text-[var(--ink-mute)]">{field.type}</span>
              {field.required ? (
                <span className="mono rounded border border-[var(--line)] px-1 text-[9px] uppercase tracking-wider text-[var(--ink-3)]">required</span>
              ) : null}
              {field.default !== undefined ? (
                <span className="mono ml-auto min-w-0 truncate text-[10.5px] text-[var(--ink-3)]" title={`Default: ${String(field.default)}`}>
                  = {String(field.default)}
                </span>
              ) : null}
            </div>
            {field.description ? (
              <span className="text-[11.5px] leading-snug text-[var(--ink-3)]">{field.description}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** `{{var}}` placeholders stand out; one that no field declares is flagged, since it renders empty at run time. */
function Placeholders({ text, known }: { text: string; known: string[] }) {
  const parts = text.split(/(\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\})/g);
  return (
    <>
      {parts.map((part, index) => {
        const match = /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/.exec(part);
        if (!match) return <span key={index}>{part}</span>;
        const declared = known.includes(match[1]!);
        return (
          <span
            key={index}
            title={declared ? `Input ${match[1]}` : `${match[1]} is not declared in input_schema — it renders empty`}
            className={cn(
              "rounded px-0.5",
              declared ? "bg-[var(--accent-2)] text-[var(--ink)]" : "bg-[var(--warn-2)] text-[var(--ink-2)] underline decoration-dotted",
            )}
          >
            {part}
          </span>
        );
      })}
    </>
  );
}
