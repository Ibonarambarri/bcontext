"use client";

/**
 * The inline property pill — "Status Backlog", "Priority High" — and the
 * vocabularies it offers. Shared by the floating panel's identity strip
 * (`node-inspector.tsx`) and the node page's strip (`task-inspector.tsx`),
 * so a task reads the same wherever it is opened. Which status list a node
 * may move through is decided by its KIND, never by what it currently says:
 * offering a goal "In progress" would let one click turn an objective into
 * something no goal surface can read.
 */

import { ListBox, Select } from "@heroui/react";
import { GOAL_STATUSES, GOAL_STATUS_DOT } from "@/lib/goals/presentation";
import {
  isGoalStatus,
  type NodeKind,
  type NodeStatus,
  type Priority,
  type TaskStatus,
} from "@bcontext-dev/contract/types";
import { cn } from "@bcontext-dev/contract/utils";

export const TASK_STATUSES: TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "blocked",
  "done",
  "archived",
];

export const PRIORITIES: Priority[] = ["low", "med", "high", "urgent"];

export function statusesFor(kind: NodeKind): NodeStatus[] {
  return kind === "goal" ? GOAL_STATUSES : TASK_STATUSES;
}

export const STATUS_DOT: Record<NodeStatus, string> = {
  backlog: "var(--ink-mute)",
  todo: "#5f83c7",
  in_progress: "#d99a3d",
  review: "#8a70c7",
  blocked: "#d46464",
  done: "#62966d",
  archived: "var(--ink-mute)",
  ...GOAL_STATUS_DOT,
};

export const PRIORITY_DOT: Record<Priority, string> = {
  low: "var(--ink-mute)",
  med: "#5f83c7",
  high: "#d99a3d",
  urgent: "#d46464",
};

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * The Select hands back a plain string. It can only be one of the values
 * the node's kind put in the list, so this is a check against that list
 * rather than a cast that would happily let anything through.
 */
export function asNodeStatus(value: string): NodeStatus | null {
  if (isGoalStatus(value)) return value;
  return isTaskStatus(value) ? value : null;
}

/**
 * One pill per property: a dot for the value's meaning, the property name
 * in muted ink, the value, and the chevron — a single line that reads
 * "Status Backlog", never a stacked label box.
 */
export function PropertySelect({
  label,
  value,
  options,
  disabled,
  onChange,
  dots,
  className,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
  dots?: Record<string, string>;
  className?: string;
}) {
  return (
    <Select
      aria-label={label}
      isDisabled={disabled}
      value={value}
      onChange={(key) => onChange(key == null ? "" : String(key))}
      className={cn("min-w-0 max-w-full", className)}
    >
      {/* The selected item's own rendering (dot + label) is what
          Select.Value shows, so the trigger adds only the property name. */}
      <Select.Trigger className="inline-flex h-7 w-full max-w-full items-center gap-1.5 overflow-hidden rounded-full border border-[var(--line)] bg-[var(--paper)] py-0 pl-2.5 pr-1.5 text-[11.5px] leading-none text-[var(--ink)] hover:border-[var(--line-strong)]">
        <span className="shrink-0 text-[var(--ink-mute)]">{label}</span>
        <Select.Value className="min-w-0 truncate font-medium" />
        <Select.Indicator className="shrink-0 opacity-60" />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
              <span className="flex min-w-0 items-center gap-1.5">
                {dots ? <i aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ background: dots[option.value] ?? "transparent", boxShadow: dots[option.value] ? "none" : "inset 0 0 0 1px var(--line-strong)" }} /> : null}
                <span className="truncate">{option.label}</span>
              </span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
