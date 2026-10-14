/**
 * Titles are names, not codes.
 *
 * Agents planning work reach for `F01 — …`, `NEXO-03 — …`, `P4-05 — …`:
 * a numbering that means something in the session that wrote it and
 * nothing to the next reader, and that goes stale the first time the plan
 * is reordered. The id is the reference; the title says what the node is.
 *
 * This is a nudge, not a gate: the write goes through and the response
 * carries `title_hint`, so the agent fixes it in one call and learns the
 * house style from the reply rather than from a refusal.
 */

/** `F01 — `, `NEXO-03: `, `P4-05 ·`, `AI-GW-00 — `, `UIX-NEXO — ` */
// A code has a hyphenated part (`AI-GW-00`, `UIX-NEXO`) or ends in digits
// (`F01`, `P13`); a plain word before a colon (`NEXO: …`) is a name.
const CODE_PREFIX = /^(?:[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|[A-Z]{1,6}\d{1,4})\s*[—–:·-]\s+/;
/** Any ` — ` / ` – ` used as a separator inside the title. */
const DASH_SEPARATOR = /\s[—–]\s/;
/** `1. Do X`, `01 Do X`, `Phase 2:` */
const NUMBERED = /^(?:\d{1,3}[.)]?\s+|(?:phase|fase|step|paso)\s+\d+\s*[:—–-]\s*)/i;

export function titleHint(title: string): string | null {
  const t = title.trim();
  if (CODE_PREFIX.test(t) || NUMBERED.test(t)) {
    return "title_hint: titles are names, not codes — drop the prefix/numbering (`F01`, `NEXO-03`, `1.`) and say what it is, e.g. `Queue worker on pg-boss`. The id is the reference.";
  }
  if (DASH_SEPARATOR.test(t)) {
    return "title_hint: no dash separators in titles (` — `); use a colon or a plain sentence, e.g. `Realtime: move presence off Supabase`.";
  }
  return null;
}
