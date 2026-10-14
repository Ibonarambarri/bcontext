"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@heroui/react";

/**
 * Lazy wrapper for the 30-day activity chart. The `AreaChart`
 * drags all of recharts (~90 KB gzip) with it — far too heavy for the
 * workspace shell's synchronous first load. The chart hydrates in a second
 * async chunk while this skeleton mirrors its exact footprint (260px chart
 * area + axis row), so there is no layout shift.
 */
const DashboardActivityChartImpl = dynamic(
  () => import("./dashboard-activity-chart-impl").then((m) => m.DashboardActivityChart),
  {
    loading: () => (
      <div role="status" aria-label="Loading activity chart" className="h-[260px] w-full">
        <Skeleton aria-hidden="true" className="h-full w-full rounded-lg" />
      </div>
    ),
  },
);

export function DashboardActivityChart(
  props: React.ComponentProps<typeof DashboardActivityChartImpl>,
) {
  return <DashboardActivityChartImpl {...props} />;
}
