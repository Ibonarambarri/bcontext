import { DashboardSkeleton } from "@/components/skeletons";

/**
 * Workspace overview loading state — mirrors the real dashboard layout
 * (mini-stats, activity chart card, two overview lists, decisions row)
 * so content streams in without layout shift.
 */
export default function Loading() {
  return <DashboardSkeleton />;
}
