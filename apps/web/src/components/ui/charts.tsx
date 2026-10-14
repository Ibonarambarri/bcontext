"use client";

/**
 * LineChart / AreaChart — recharts in a responsive container, with the app's
 * axis, grid and tooltip look. The workspace dashboard's activity chart is an
 * AreaChart; the admin dashboard's usage chart is a LineChart.
 *
 * The parts are recharts' own components re-exported under the chart's
 * namespace (`LineChart.XAxis` is recharts' `XAxis`), because recharts finds
 * its children by component type — a wrapper around `XAxis` would not be
 * recognised as an axis. Styling therefore lives in `ui.css` under the
 * `.bctx-chart` root class, not on the parts.
 */
import type { CSSProperties, ReactNode } from "react";
import {
  Area,
  AreaChart as RechartsAreaChart,
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@bcontext-dev/contract/utils";

type Datum = Record<string, unknown>;

interface ChartRootProps {
  data: Datum[];
  height?: number;
  width?: number | `${number}%`;
  margin?: { top?: number; right?: number; bottom?: number; left?: number };
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

const DEFAULT_MARGIN = { top: 8, right: 8, bottom: 0, left: 0 };

function LineRoot({ data, height = 300, width = "100%", margin = DEFAULT_MARGIN, className, style, children }: ChartRootProps) {
  return (
    <div data-slot="line-chart" className={cn("bctx-chart w-full", className)} style={style}>
      <ResponsiveContainer width={width} height={height}>
        <RechartsLineChart data={data} margin={margin}>
          {children}
        </RechartsLineChart>
      </ResponsiveContainer>
    </div>
  );
}

function AreaRoot({ data, height = 300, width = "100%", margin = DEFAULT_MARGIN, className, style, children }: ChartRootProps) {
  return (
    <div data-slot="area-chart" className={cn("bctx-chart w-full", className)} style={style}>
      <ResponsiveContainer width={width} height={height}>
        <RechartsAreaChart data={data} margin={margin}>
          {children}
        </RechartsAreaChart>
      </ResponsiveContainer>
    </div>
  );
}

interface TooltipPayloadItem {
  name?: string | number;
  dataKey?: string | number | ((obj: unknown) => unknown);
  value?: unknown;
  color?: string;
  stroke?: string;
  fill?: string;
  payload?: { fill?: string };
}

/**
 * The tooltip body: an optional header (the x value) and one row per series
 * with its colour, name and value. recharts clones it with `active`,
 * `payload` and `label`; call sites pass only the formatters.
 */
function TooltipContent({
  active,
  payload,
  label,
  hideHeader = false,
  labelFormatter,
  valueFormatter,
  className,
}: {
  active?: boolean;
  payload?: readonly TooltipPayloadItem[];
  label?: ReactNode;
  hideHeader?: boolean;
  labelFormatter?: (label: ReactNode) => ReactNode;
  valueFormatter?: (value: unknown) => ReactNode;
  className?: string;
}) {
  if (!active || !payload?.length) return null;
  const header = labelFormatter ? labelFormatter(label ?? "") : label;
  return (
    <div
      data-slot="chart-tooltip"
      className={cn(
        "flex min-w-[140px] flex-col gap-1.5 rounded-[var(--radius)] border border-separator bg-overlay px-3 py-2 shadow-overlay",
        className,
      )}
    >
      {!hideHeader && header !== undefined && header !== null && header !== "" ? (
        <div className="text-xs font-medium text-muted">{header}</div>
      ) : null}
      {payload.map((item, index) => {
        const color = item.stroke || item.color || item.fill || item.payload?.fill;
        const value = valueFormatter ? valueFormatter(item.value ?? "") : (item.value as ReactNode);
        const key = typeof item.dataKey === "function" ? index : (item.dataKey ?? item.name ?? index);
        return (
          <div key={`${key}-${index}`} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span className="flex-1 text-xs text-muted">{item.name ?? (typeof item.dataKey === "function" ? "" : item.dataKey)}</span>
            <span className="text-xs font-semibold text-foreground">{value}</span>
          </div>
        );
      })}
    </div>
  );
}

export const LineChart = Object.assign(LineRoot, {
  Grid: CartesianGrid,
  XAxis,
  YAxis,
  Line,
  Tooltip,
  TooltipContent,
});

export const AreaChart = Object.assign(AreaRoot, {
  Grid: CartesianGrid,
  XAxis,
  YAxis,
  Area,
  Tooltip,
  TooltipContent,
});
