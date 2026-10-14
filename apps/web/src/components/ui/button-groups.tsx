"use client";

/**
 * RadioButtonGroup / CheckboxButtonGroup — single and multiple choice drawn
 * as bordered tiles instead of bare radios and checkboxes. Used by the Nexo
 * settings (tone, autonomy, what it can do), the Nexo source binding mode,
 * the agent scope pickers and the workspace picker of an org invitation.
 *
 * Built on HeroUI's RadioGroup/Radio and CheckboxGroup/Checkbox, so focus,
 * keyboard, form values and `isDisabled` are React Aria's. The field root of
 * each item is `display: contents`; the tile is the field's clickable
 * content, which carries `data-selected` — the selected ring keys off it.
 * The indicator is the native control pinned to the tile's top-right corner.
 */
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { Checkbox, CheckboxGroup, Radio, RadioGroup } from "@heroui/react";
import { cn } from "@bcontext-dev/contract/utils";

/** Shared tile look: surface card, hairline border, accent ring when selected. */
const TILE = cn(
  "relative flex cursor-pointer flex-col items-stretch gap-4 rounded-2xl border border-border bg-surface px-5 py-4 outline-none",
  "[-webkit-tap-highlight-color:transparent]",
  "data-[selected=true]:border-transparent data-[selected=true]:ring-2 data-[selected=true]:ring-accent",
  "data-[focus-visible=true]:ring-2 data-[focus-visible=true]:ring-focus",
  "data-[disabled=true]:pointer-events-none data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50",
);
const INDICATOR = "absolute end-4 top-3";
const ITEM_CONTENT = "flex min-w-0 flex-col";

function RadioRoot({
  layout = "flex",
  className,
  children,
  ...rest
}: Omit<ComponentProps<typeof RadioGroup>, "children"> & { layout?: "flex" | "grid"; children?: ReactNode }) {
  return (
    <RadioGroup
      data-slot="radio-button-group"
      className={cn(layout === "grid" ? "grid" : "flex", "gap-3", typeof className === "string" ? className : undefined)}
      {...rest}
    >
      {children}
    </RadioGroup>
  );
}

function RadioItem({
  className,
  children,
  ...rest
}: Omit<ComponentProps<typeof Radio>, "children" | "className"> & { className?: string; children?: ReactNode }) {
  return (
    <Radio data-slot="radio-button-group-item" className="contents" {...rest}>
      <Radio.Content className={cn(TILE, className)}>{children}</Radio.Content>
    </Radio>
  );
}

function RadioIndicator({ className }: { className?: string }) {
  return (
    <Radio.Control data-slot="radio-button-group-indicator" className={cn(INDICATOR, className)}>
      <Radio.Indicator />
    </Radio.Control>
  );
}

function ItemContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="button-group-item-content" className={cn(ITEM_CONTENT, className)} {...rest} />;
}

export const RadioButtonGroup = Object.assign(RadioRoot, {
  Item: RadioItem,
  Indicator: RadioIndicator,
  ItemContent,
});

function CheckboxRoot({
  className,
  children,
  ...rest
}: Omit<ComponentProps<typeof CheckboxGroup>, "children"> & { children?: ReactNode }) {
  return (
    <CheckboxGroup
      data-slot="checkbox-button-group"
      className={cn("flex gap-3", typeof className === "string" ? className : undefined)}
      {...rest}
    >
      {children}
    </CheckboxGroup>
  );
}

function CheckboxItem({
  className,
  children,
  ...rest
}: Omit<ComponentProps<typeof Checkbox>, "children" | "className"> & { className?: string; children?: ReactNode }) {
  return (
    <Checkbox data-slot="checkbox-button-group-item" className="contents" {...rest}>
      <Checkbox.Content className={cn(TILE, className)}>{children}</Checkbox.Content>
    </Checkbox>
  );
}

function CheckboxIndicator({ className }: { className?: string }) {
  return (
    <Checkbox.Control data-slot="checkbox-button-group-indicator" className={cn(INDICATOR, className)}>
      <Checkbox.Indicator />
    </Checkbox.Control>
  );
}

export const CheckboxButtonGroup = Object.assign(CheckboxRoot, {
  Item: CheckboxItem,
  Indicator: CheckboxIndicator,
  ItemContent,
});
