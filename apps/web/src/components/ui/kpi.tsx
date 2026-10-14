/**
 * KPI — one headline number with a title above and a line of context below.
 * The admin dashboard's metric tiles are KPIs.
 *
 * The value is written by the call site into `KPI.Content` with the
 * `kpi__value` class (styled in `ui.css`): the admin figures arrive already
 * formatted ("3 / 5", a currency), so there is no number-formatting slot.
 */
import type { HTMLAttributes } from "react";
import { cn } from "@bcontext-dev/contract/utils";

function Root({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="kpi"
      className={cn("relative flex flex-col rounded-[calc(var(--radius)*2)] p-4", className)}
      {...rest}
    />
  );
}

function Header({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="kpi-header" className={cn("mb-1 flex items-center gap-2", className)} {...rest} />;
}

function Title({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="kpi-title" className={cn("text-sm font-medium text-muted", className)} {...rest} />;
}

function Content({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="kpi-content"
      className={cn("grid flex-1 grid-cols-[1fr_auto] items-center gap-x-2", className)}
      {...rest}
    />
  );
}

function Footer({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="kpi-footer" className={cn("-mb-1", className)} {...rest} />;
}

export const KPI = Object.assign(Root, { Header, Title, Content, Footer });
