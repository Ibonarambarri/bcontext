/**
 * Canonical starter skills.
 *
 * Three skills shipped on every workspace template:
 *
 *   - triage_inbox                  — sweep recent unsorted nodes into
 *                                      the right kind/tags/parent
 *   - weekly_review                 — produce a 200-word weekly recap
 *                                      grouped by shipped / decisions /
 *                                      blockers
 *   - extract_decisions_from_meeting — turn a meeting note's body into
 *                                      a list of ADRs ready to file
 *
 * Each skill is a typed `skill` node whose body is the frontmatter-rich
 * template runSkill() consumes. Frontmatter shape matches
 * `src/lib/skills/run.ts :: SkillFrontmatter`:
 *
 *   ---
 *   title: <display>
 *   model: <optional override>
 *   input_schema:
 *     fields:
 *       - name: <ident>
 *         type: string | number | boolean
 *         required: true|false
 *         default: <optional>
 *   system: <optional system prompt>
 *   ---
 *
 *   <prompt body with {{var}} placeholders>
 */

export interface StarterSkill {
  key: string;
  title: string;
  body: string;
}

export const TRIAGE_INBOX: StarterSkill = {
  key: "skill-triage-inbox",
  title: "Skill — triage inbox",
  body: `---
title: Triage inbox
input_schema:
  fields:
    - name: nodes_dump
      type: string
      required: true
      description: Recent unsorted nodes as a flat list (title, kind, snippet).
    - name: available_tags
      type: string
      required: false
      default: business, product, tech, ai
system: |
  You are a workspace triage assistant. Your job is to classify each
  inbound node into the right kind (doc/task/decision/meeting/
  bug/adr/skill), assign zero or more existing workspace tags, and propose
  an optional semantic parent. Kind is primary semantics; tags express
  aboutness and never permissions.
  Never invent metadata you can't justify from the snippet.
---

You are looking at unsorted nodes from a Bcontext workspace. For each
node in the dump below, return one JSON line:

\`\`\`
{"title": "...", "kind": "...", "tags": ["..."], "parent_hint": "..."}
\`\`\`

Rules:
- Kinds: doc | task | decision | meeting | bug | adr | skill.
- Tags must come from this workspace list: {{available_tags}}. Use multiple
  tags only when each one is justified; use an empty array when ambiguous.
- Decisions, meetings, tasks and bugs are kinds, not duplicate tags.
- \`parent_hint\` is a short phrase identifying an existing semantic node
  the operator can search for — never a fabricated id.
- Skip nodes that already look well-classified.

Nodes:

{{nodes_dump}}
`,
};

export const WEEKLY_REVIEW: StarterSkill = {
  key: "skill-weekly-review",
  title: "Skill — weekly review",
  body: `---
title: Weekly review
input_schema:
  fields:
    - name: activity_summary
      type: string
      required: true
      description: Flat list of node changes from the last 7 days.
    - name: workspace_name
      type: string
      required: false
      default: this workspace
system: |
  You produce terse weekly recaps for AI-first teams. Markdown only.
  Group by Shipped / Decisions / Blockers / Question for next week.
  Keep total length under 200 words. No filler ("Great week!", etc.).
---

Generate the weekly review for **{{workspace_name}}** from the activity
summary below.

Output format:

\`\`\`
## Shipped
- <one bullet per closed task / merged change>

## Decisions made
- <ADRs created or status flipped>

## Open blockers
- <bugs without owner, or > 3 days old>

## Question I should ask myself next week
- <a single, pointed question>
\`\`\`

Hard cap: 200 words across all four sections.

Activity:

{{activity_summary}}
`,
};

export const EXTRACT_DECISIONS_FROM_MEETING: StarterSkill = {
  key: "skill-extract-decisions",
  title: "Skill — extract decisions from meeting",
  body: `---
title: Extract decisions from meeting
input_schema:
  fields:
    - name: meeting_notes
      type: string
      required: true
      description: Raw meeting transcript or notes.
    - name: participants
      type: string
      required: false
      default: unknown
system: |
  You turn raw meeting notes into ADR-ready records. Be conservative —
  only emit decisions that the participants actually decided. Anything
  speculative goes under "Open questions" instead of becoming an ADR.
---

Read the meeting notes below and produce a Markdown response with
two sections:

\`\`\`
## Decisions
For each decision actually made, emit a block in this shape:

### ADR — <one-line decision>
- **Status:** Accepted
- **Context:** <one sentence — the problem under discussion>
- **Decision:** <one sentence — what was chosen>
- **Consequences:** <one or two bullets — what changes>

## Open questions
- <one bullet per question that came up but was not resolved>
\`\`\`

Rules:
- Only emit ADRs for decisions that have a clear "decision: <X>" stance.
  Hedged language ("maybe", "we'll see") → goes to Open questions.
- Participants: {{participants}}. Attribute the decision to the room,
  not to an individual, unless the notes are explicit.
- If no decisions were made, emit \`## Decisions\` with the single line
  "_None recorded._" and proceed to Open questions.

Meeting notes:

{{meeting_notes}}
`,
};

export const STARTER_SKILLS: StarterSkill[] = [
  TRIAGE_INBOX,
  WEEKLY_REVIEW,
  EXTRACT_DECISIONS_FROM_MEETING,
];
