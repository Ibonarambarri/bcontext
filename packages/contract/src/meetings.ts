/**
 * Meeting refinement — the state a meeting node's transcript processing is in.
 * Contract between bcontext-api and bcontext-web.
 */
export type RefineStatus = "pending" | "done" | "failed" | "skipped";
