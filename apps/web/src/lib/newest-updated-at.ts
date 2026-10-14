/**
 * The freshest `updated_at` a client knows for a node, out of the values it
 * holds: the inspector payload, the workspace overlay (where confirmed writes
 * and peers' broadcasts land), a component's own last fold. Guarded writes
 * send this as `if_updated_at`, so a status change made right after the body
 * editor saved is not refused as a conflict with the person's own edit.
 */
export function newestUpdatedAt(...candidates: Array<string | null | undefined>): string | undefined {
  let best: string | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const time = Date.parse(candidate);
    if (Number.isNaN(time)) {
      if (best === undefined) best = candidate;
      continue;
    }
    if (time > bestTime) {
      best = candidate;
      bestTime = time;
    }
  }
  return best;
}
