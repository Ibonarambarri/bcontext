import { NodePageSkeleton } from "@/components/skeletons";

/**
 * Node page loading state — mirrors the editor layout (title, tag row,
 * prose lines) inside the same --edit-max container the editor uses.
 */
export default function Loading() {
  return <NodePageSkeleton />;
}
