"use client";

/**
 * Shared kebab menu for cards (Tools providers, Agents, board cards). Follows
 * the sidebar CustomViewMenuItem precedent: Dropdown.Trigger three-dot button
 * + bottom-end popover with icon + label items. Destructive items get the
 * danger treatment here but must confirm at the call site (AlertDialog /
 * `useDeleteNode`) — the menu itself never runs an action.
 */

import type { ComponentType } from "react";
import { EllipsisVertical } from "lucide-react";
import { Dropdown, Label } from "@heroui/react";

/** One menu entry; `id` is what `onAction` receives. */
export interface CardAction {
  id: string;
  label: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
  danger?: boolean;
}

export function CardActionsMenu({ ariaLabel, isDisabled, actions, onAction }: {
  ariaLabel: string;
  isDisabled?: boolean;
  actions: CardAction[];
  onAction: (key: string) => void;
}) {
  return (
    <Dropdown>
      <Dropdown.Trigger
        aria-label={ariaLabel}
        isDisabled={isDisabled}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--ink-3)] outline-none transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)] focus-visible:bg-[var(--paper-2)] disabled:opacity-40"
      >
        <EllipsisVertical size={14} />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end" className="min-w-[170px]">
        <Dropdown.Menu aria-label={ariaLabel} onAction={(key) => onAction(String(key))}>
          {actions.map(({ id, label, Icon, danger }) => (
            <Dropdown.Item key={id} id={id} textValue={label} className={danger ? "text-danger" : undefined}>
              <Icon size={12} />
              <Label>{label}</Label>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
