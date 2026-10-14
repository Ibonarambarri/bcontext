"use client";

import { AreaChart } from "@/components/ui/charts";
import type { ActivityPoint } from "@/lib/overview";

/**
 * Client island for the workspace dashboard's 30-day activity chart.
 * Recharts needs the browser, so the server page computes the series
 * (`activitySeries` in src/lib/overview.ts) and passes it in as a plain,
 * serializable prop.
 */
export function DashboardActivityChart({ data, colors }: { data: ActivityPoint[]; colors: { created: string; updated: string } }) {
  return (
    <div style={{ "--dash-created": colors.created, "--dash-updated": colors.updated } as React.CSSProperties}>
    <AreaChart data={data as unknown as Record<string, string | number>[]} height={260}>
      <defs>
        <linearGradient id="created-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--dash-created)" stopOpacity={0.2} />
          <stop offset="100%" stopColor="var(--dash-created)" stopOpacity={0.02} />
        </linearGradient>
        <linearGradient id="updated-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--dash-updated)" stopOpacity={0.2} />
          <stop offset="100%" stopColor="var(--dash-updated)" stopOpacity={0.02} />
        </linearGradient>
      </defs>
      <AreaChart.Grid vertical={false} />
      <AreaChart.XAxis dataKey="date" tickMargin={8} interval="preserveStartEnd" />
      <AreaChart.YAxis width={30} allowDecimals={false} />
      <AreaChart.Area
        dataKey="created"
        dot={false}
        fill="url(#created-fill)"
        name="Created"
        stroke="var(--dash-created)"
        strokeWidth={2}
        type="monotone"
      />
      <AreaChart.Area
        dataKey="updated"
        dot={false}
        fill="url(#updated-fill)"
        name="Updated"
        stroke="var(--dash-updated)"
        strokeWidth={2}
        type="monotone"
      />
      <AreaChart.Tooltip content={<AreaChart.TooltipContent />} />
    </AreaChart>
  </div>
  );
}
