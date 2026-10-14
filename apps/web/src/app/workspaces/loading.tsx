import { WorkspacesHubSkeleton } from "@/components/skeletons";

/**
 * Workspaces hub loading state — mirrors WorkspacesView (top nav, header
 * row, organization section, card grid) so the server-rendered hub streams
 * in without layout shift.
 */
export default function Loading() {
  return <WorkspacesHubSkeleton />;
}
