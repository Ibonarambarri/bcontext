/**
 * Server-safe types + helpers for the meeting node view.
 *
 * Lives outside the client component so the Server Component page can
 * import `resolveDefaultView` to compute the initial tab on the server
 * without dragging React client runtime into the RSC graph.
 */
import type { RefineStatus } from "@bcontext-dev/contract/meetings";

export type MeetingView = "refined" | "transcript";

/** Which tab a meeting opens on: the transcript until a refine has landed. */
export function resolveDefaultView(
  status: RefineStatus | undefined,
  hasTranscript: boolean,
): MeetingView {
  if (!hasTranscript) return "refined";
  // No refine yet → the bruto is what's in content_md, label it "transcript".
  if (status !== "done") return "transcript";
  return "refined";
}
