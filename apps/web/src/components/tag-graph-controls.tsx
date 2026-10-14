"use client";

/**
 * Tag authoring UI for the Brain graph's Tags focus (`graph-view.tsx`):
 * the hover card over a tag node and the "Add tag" modal. Creating and
 * inspecting a tag is the same job wherever the taxonomy is drawn, so the
 * graph gets these instead of a Tags view of its own. Renaming, merging and
 * deleting live in `tag-manager.tsx` (Settings → Tags and the graph's
 * side panel); this file only creates and describes.
 */

import { useEffect, useRef, useState } from "react";
import {
  Button,
  Chip,
  CloseButton,
  ComboBox,
  FieldError,
  Input,
  Label,
  ListBox,
  Modal,
  Tag,
  TagGroup,
  TextField,
} from "@heroui/react";
import { HoverCard } from "@/components/ui/hover-card";
import type { TagRelation } from "@bcontext-dev/contract/types";
import { normalizeTagName } from "@bcontext-dev/contract/tags";
import type { TagWithUsage } from "@/lib/graph/tag-focus";

/**
 * HoverCard for the hovered tag node, anchored to a virtual trigger: an
 * invisible pointer-events-none span pinned at the node's stage pixel
 * position, so the canvas keeps receiving every pointer event and nothing in
 * the layout ever shifts. Parents/children/related are derived here from the
 * relation list the graph already holds — no fetch on hover.
 */
export function TagHoverCard({
  hover,
  open,
  tags,
  relations,
  onOpenChange,
}: {
  hover: { tag: TagWithUsage; x: number; y: number } | null;
  open: boolean;
  tags: readonly TagWithUsage[];
  relations: readonly TagRelation[];
  onOpenChange: (open: boolean) => void;
}) {
  if (!hover) return null;
  const { tag } = hover;
  const nameById = new Map(tags.map((item) => [item.id, item.name]));
  const parents = relations
    .filter((relation) => relation.relation === "parent" && relation.from_tag_id === tag.id)
    .map((relation) => nameById.get(relation.to_tag_id))
    .filter((name): name is string => Boolean(name));
  const childCount = relations.filter((relation) => relation.relation === "parent" && relation.to_tag_id === tag.id).length;
  const relatedCount = new Set(
    relations
      .filter((relation) => relation.relation === "related" && (relation.from_tag_id === tag.id || relation.to_tag_id === tag.id))
      .map((relation) => (relation.from_tag_id === tag.id ? relation.to_tag_id : relation.from_tag_id)),
  ).size;

  return (
    <HoverCard open={open} onOpenChange={onOpenChange}>
      <HoverCard.Trigger
        aria-hidden="true"
        className="pointer-events-none absolute z-30 h-px w-px"
        style={{ left: hover.x, top: hover.y }}
      />
      <HoverCard.Content placement="top" className="max-w-[300px]">
        <HoverCard.Arrow />
        <div className="space-y-2 p-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[13px] font-medium leading-snug text-foreground">#{tag.name}</p>
            <span className="shrink-0 text-[11px] text-muted">{tag.usage_count} {tag.usage_count === 1 ? "use" : "uses"}</span>
          </div>
          {parents.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-muted">Parents</span>
              {parents.map((name) => (
                <Chip key={name} size="sm" variant="soft">
                  <Chip.Label>#{name}</Chip.Label>
                </Chip>
              ))}
            </div>
          ) : (
            <p className="text-[11.5px] text-muted">Hangs off the workspace</p>
          )}
          <p className="text-[11.5px] text-muted">{childCount} {childCount === 1 ? "child" : "children"} · {relatedCount} related</p>
        </div>
      </HoverCard.Content>
    </HoverCard>
  );
}

/**
 * "Add tag" form: name (validated against `normalizeTagName` duplicates)
 * plus optional parents and related tags. Purely presentational — `onCreate`
 * receives the ids and the graph does the POST.
 */
export function AddTagModal({
  open,
  tags,
  onClose,
  onCreate,
}: {
  open: boolean;
  tags: readonly TagWithUsage[];
  onClose: () => void;
  onCreate: (input: { name: string; parentIds: string[]; relatedIds: string[] }) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [parentIds, setParentIds] = useState<string[]>([]);
  const [relatedIds, setRelatedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setName("");
    setParentIds([]);
    setRelatedIds([]);
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;
  const normalized = normalizeTagName(name);
  const duplicate = tags.some((tag) => tag.normalized_name === normalized);

  return (
    <Modal.Backdrop isOpen isDismissable onOpenChange={(next) => { if (!next) onClose(); }} className="z-[70]" variant="blur">
      <Modal.Container placement="top" className="px-3 pt-[7dvh] sm:pt-[10dvh]">
        <Modal.Dialog aria-labelledby="add-tag-title" className="scroll max-h-[84dvh] w-full max-w-[560px] overflow-y-auto">
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              if (!normalized || duplicate) return;
              onCreate({ name, parentIds, relatedIds });
            }}
          >
            <header className="sticky top-0 z-10 flex items-start justify-between border-b border-[var(--line)] bg-[var(--overlay)] px-5 py-4">
              <div>
                <h2 id="add-tag-title" className="text-[16px] font-medium text-foreground">Add tag</h2>
                <p className="mt-0.5 text-[11.5px] text-muted">New tags hang off the workspace unless you give them parents.</p>
              </div>
              <CloseButton aria-label="Close add tag" onPress={onClose} />
            </header>

            <div className="space-y-5 px-5 py-5">
              <TextField value={name} onChange={setName} isRequired maxLength={80} isInvalid={duplicate}>
                <Label>Name</Label>
                <Input ref={nameRef} placeholder="roadmap" />
                <FieldError>A tag with that name already exists.</FieldError>
              </TextField>

              <TagMultiPicker
                label="Parents"
                hint="optional · a tag with no parents hangs off the workspace"
                tags={tags}
                selectedIds={parentIds}
                onChange={setParentIds}
              />

              <TagMultiPicker
                label="Related"
                hint="optional · symmetric association"
                tags={tags}
                selectedIds={relatedIds}
                onChange={setRelatedIds}
              />
            </div>

            <footer className="sticky bottom-0 flex justify-end gap-2 border-t border-[var(--line)] bg-[var(--overlay)] px-5 py-3">
              <Button variant="outline" onPress={onClose}>Cancel</Button>
              <Button type="submit" isDisabled={!normalized || duplicate}>Add tag</Button>
            </footer>
          </form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function TagMultiPicker({
  label,
  hint,
  tags,
  selectedIds,
  onChange,
}: {
  label: string;
  hint: string;
  tags: readonly TagWithUsage[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const selectedTags = selectedIds
    .map((id) => tags.find((tag) => tag.id === id))
    .filter((tag): tag is TagWithUsage => Boolean(tag));

  return (
    <div>
      <Label className="mb-2 block">{label} <span className="text-muted">· {hint}</span></Label>
      {selectedTags.length > 0 ? (
        <TagGroup
          aria-label={`Selected ${label.toLowerCase()}`}
          selectionMode="none"
          className="mb-2"
          onRemove={(keys) => onChange(selectedIds.filter((id) => !keys.has(id)))}
        >
          <TagGroup.List items={selectedTags}>
            {(tag) => <Tag key={tag.id} id={tag.id} textValue={tag.name}>#{tag.name}</Tag>}
          </TagGroup.List>
        </TagGroup>
      ) : null}
      <ComboBox
        inputValue={query}
        onInputChange={setQuery}
        selectedKey={null}
        onSelectionChange={(key) => {
          if (key == null) return;
          const id = String(key);
          if (!selectedIds.includes(id)) onChange([...selectedIds, id]);
          setQuery("");
        }}
        aria-label={`Search tags to add as ${label.toLowerCase()}`}
      >
        <ComboBox.InputGroup>
          <Input placeholder="Search tags…" />
        </ComboBox.InputGroup>
        <ComboBox.Popover>
          <ListBox>
            {tags
              .filter((tag) => !selectedIds.includes(tag.id))
              .filter((tag) => tag.normalized_name.includes(normalizeTagName(query)))
              .slice(0, 12)
              .map((tag) => (
                <ListBox.Item key={tag.id} id={tag.id} textValue={tag.name}>#{tag.name}</ListBox.Item>
              ))}
          </ListBox>
        </ComboBox.Popover>
      </ComboBox>
    </div>
  );
}
