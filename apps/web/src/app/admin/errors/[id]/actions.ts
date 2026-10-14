"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiJson, ApiError } from "@/web/api-client";
import {
  ERROR_STATUSES,
  type AdminErrorGroup,
  type ErrorStatus,
} from "@bcontext-dev/contract/errors";

/**
 * The two writes a problem has: where triage got to, and what was found out.
 *
 * Both are the same PATCH and both live on the group rather than the event —
 * an operator resolves a problem, not one of its four thousand occurrences.
 * They are separate actions all the same, because they are pressed at
 * different moments: the status changes the second you have looked, the note
 * is written once you know something, and one saving the other would either
 * lose a half-typed note or silently re-file a problem somebody was only
 * annotating.
 *
 * Admin gating lives in the route (`gateAdmin`), so the action's only job is
 * to turn the press into the call and refresh what it changed. The list is
 * revalidated too: a resolved problem leaves the default view and the status
 * counts in the filter bar move with it.
 */
async function patch(
  id: string,
  body: { status?: ErrorStatus; note?: string },
): Promise<AdminErrorGroup> {
  try {
    const group = await apiJson<AdminErrorGroup>(
      `/api/admin/errors/${encodeURIComponent(id)}`,
      { method: "PATCH", json: body },
    );
    revalidatePath(`/admin/errors/${id}`);
    revalidatePath("/admin/errors");
    return group;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      redirect(`/login?next=/admin/errors/${id}`);
    }
    throw err instanceof ApiError ? new Error(err.message) : err;
  }
}

export interface ErrorStatusState {
  error?: string;
  /** The status the API confirmed, so the control shows what actually stuck
   *  rather than what was pressed. */
  saved?: ErrorStatus;
}

export async function setErrorStatusAction(
  _prev: ErrorStatusState,
  formData: FormData,
): Promise<ErrorStatusState> {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "") as ErrorStatus;
  if (!id) return { error: "Missing problem." };
  if (!ERROR_STATUSES.includes(status)) return { error: "Invalid status." };
  try {
    const group = await patch(id, { status });
    return { saved: group.status };
  } catch (err) {
    // Returned rather than thrown: the page around this control is the only
    // record of what broke, and replacing it with an error screen because a
    // PATCH failed loses exactly the thing the operator came to read.
    return { error: err instanceof Error ? err.message : "Couldn't save it." };
  }
}

export interface ErrorNoteState {
  error?: string;
  /** Confirmed by the API, so the box can stop claiming unsaved work. */
  saved?: string;
}

export async function saveErrorNoteAction(
  _prev: ErrorNoteState,
  formData: FormData,
): Promise<ErrorNoteState> {
  const id = String(formData.get("id") ?? "");
  // Not trimmed away to nothing: emptying the box is how a note that turned
  // out to be wrong is removed, and it has to reach the API as an empty
  // string rather than as "no change".
  const note = String(formData.get("note") ?? "").trim();
  if (!id) return { error: "Missing problem." };
  try {
    const group = await patch(id, { note });
    return { saved: group.note ?? "" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't save it." };
  }
}
