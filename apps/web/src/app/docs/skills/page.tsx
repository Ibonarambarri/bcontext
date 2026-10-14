/**
 * `/docs/skills` — skill nodes, the AGENTS.md/CLAUDE.md generator and
 * executable skills (`skills_run`). Static prose.
 */
import { headers } from "next/headers";
import { appOrigin } from "@/web/public-origin";
import { Code, DocHeader, DocSection, Inline } from "../_components";

export const metadata = {
  title: "Skill recipes — Bcontext docs",
  description:
    "What a skill node is, how the AGENTS.md generator works, and two example skills you can copy.",
};

const SKILL_NODE = `---
name: prefer-server-components
description: When and why to lean on RSC in this codebase.
---

# Prefer Server Components

- Default to server components. Client components are an opt-in via "use client".
- Never fetch data in a client component — pass it as a prop from a server parent.
- For shared state, use URL search params first, React state second.
- Use the suspense boundary nearest the data fetch, not the route root.`;

const REVIEW_SKILL = `---
name: pr-review-checklist
description: How an agent should review a pull request in this repo.
---

# PR review checklist

1. **Scope.** One concern per PR. Flag bundles of unrelated changes.
2. **Tests.** New behavior needs a vitest test in src/**/*.test.ts.
3. **Types.** No \`any\` in new code; prefer \`unknown\` + narrowing.
4. **Migrations.** Schema changes require a numbered file under supabase/migrations/.
5. **Docs.** If the public API changed, /docs needs an update.`;

const AGENTS_MD = `# AGENTS.md

Agent skills curated in the **acme** Bcontext workspace.

_Generated. Do not edit by hand — change the underlying skill node and re-export._

## prefer-server-components

When and why to lean on RSC in this codebase.

# Prefer Server Components
...`;

export default async function SkillsDocsPage() {
  const origin = appOrigin(await headers());
  return (
    <article className="max-w-3xl">
      <DocHeader
        eyebrow="Skill recipes"
        title="One source of truth for agent rules."
        lede="Skills are typed nodes with frontmatter + markdown body. The generator exports them to AGENTS.md, CLAUDE.md, .cursor/rules, and .clinerules so every coding agent on your repo agrees."
      />

      <DocSection title="What is a skill node?">
        <p>
          A <Inline>skill</Inline> is one of the first-class node kinds in
          Bcontext. Its body must start with YAML frontmatter:{" "}
          <Inline>name</Inline> (required, becomes the section heading) and{" "}
          <Inline>description</Inline> (optional, short one-liner). The
          markdown below the frontmatter is the rule itself.
        </p>
        <Code label="Skill node body" code={SKILL_NODE} />
      </DocSection>

      <DocSection title="The generator">
        <p>
          From any workspace you can export the curated skill set to four
          target formats. The same set of skill nodes drives:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <Inline>AGENTS.md</Inline> — universal &quot;cursor for agents&quot;
            format, drop at repo root.
          </li>
          <li>
            <Inline>CLAUDE.md</Inline> — picked up by Claude Code at session
            start.
          </li>
          <li>
            <Inline>.cursor/rules</Inline> — Cursor reads each rule file at
            project open.
          </li>
          <li>
            <Inline>.clinerules</Inline> — Cline picks up rule blocks
            inline.
          </li>
        </ul>
        <p>
          The generator is a pure function (<Inline>src/lib/skills/generate.ts</Inline>)
          — same skills in, same bytes out. Wire it into your CI to commit
          regenerated rules whenever the underlying nodes change.
        </p>
        <Code label="Generated AGENTS.md (excerpt)" code={AGENTS_MD} />
      </DocSection>

      <DocSection title="Example: a code-review skill">
        <p>
          Skills aren&apos;t just about style. Use them to encode review
          procedures, deployment runbooks, or post-incident lessons. The
          agent reads the same checklist a human would.
        </p>
        <Code label="pr-review-checklist.md" code={REVIEW_SKILL} />
      </DocSection>

      <DocSection title="Executable skills — skills_run">
        <p>
          A skill node can also be a typed prompt template you invoke with structured input. The MCP tool <Inline>skills_run</Inline> and the REST endpoint <Inline>POST /api/skills/[id]/run</Inline> both consume the same frontmatter shape: declare your input fields, write the body with <Inline>{`{{var}}`}</Inline> placeholders, and the runtime validates, renders, and forwards to the AI Gateway.
        </p>
        <Code
          label="Skill body (executable)"
          code={`---
title: Weekly review
model: anthropic/claude-sonnet-4-6
input_schema:
  fields:
    - name: activity_summary
      type: string
      required: true
system: |
  You produce terse weekly recaps. Markdown only. Under 200 words.
---

Generate the weekly review from the activity summary below.

Activity:

{{activity_summary}}`}
        />
        <Code
          label="Invoke via REST"
          code={`curl -X POST ${origin}/api/skills/<node_id>/run \\
  -H "Authorization: Bearer bctx_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "workspace": "bcontext",
    "input": { "activity_summary": "..." }
  }'`}
          caption="Returns { rendered_prompt, output, model_used, input_validated }."
        />
        <p>
          Every workspace template seeds three canonical starters: <Inline>triage_inbox</Inline>, <Inline>weekly_review</Inline>, and <Inline>extract_decisions_from_meeting</Inline>. They are root-level <Inline>skill</Inline> nodes tagged <Inline>ai</Inline> in the indie-hacker / ai-agency / startup-founder templates.
        </p>
      </DocSection>

      <DocSection title="Tips">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Keep each skill short (under 30 lines). Long skills get
            ignored by the model.
          </li>
          <li>
            Name skills with kebab-case verbs (
            <Inline>prefer-server-components</Inline>,{" "}
            <Inline>review-prs</Inline>).
          </li>
          <li>
            Edit in the Bcontext web app. The MCP server exposes skills as
            resources, so agents see updates without a re-sync.
          </li>
          <li>
            For executable skills, the frontmatter <Inline>system:</Inline> block sets the system prompt at run time; <Inline>model:</Inline> pins the LLM (falls back to <Inline>CHAT_MODEL</Inline> env).
          </li>
        </ul>
      </DocSection>
    </article>
  );
}
