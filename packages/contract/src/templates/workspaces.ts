/**
 * Folderless workspace templates. Every entry is a semantic node; reusable
 * tags classify it and `parent` is used only when the content has a genuine
 * hierarchy relationship.
 */
import type { NodeKind } from "../types.js";
import { STARTER_SKILLS, type StarterSkill } from "../skills/starter.js";

export interface TemplateNode {
  key: string;
  parent: string | null;
  title: string;
  kind: NodeKind;
  slug?: string;
  content_md?: string;
  /** Existing reusable workspace tag names/slugs. */
  tags?: string[];
}

export interface WorkspaceTemplate {
  id: string;
  name: string;
  description: string;
  nodes: TemplateNode[];
}

function starterSkillNodes(parent: string | null = null): TemplateNode[] {
  return STARTER_SKILLS.map((skill: StarterSkill) => ({
    key: skill.key,
    parent,
    title: skill.title,
    kind: "skill",
    tags: ["ai"],
    content_md: skill.body,
  }));
}

const INDIE_HACKER: WorkspaceTemplate = {
  id: "indie-hacker",
  name: "Indie hacker (multi-project brain)",
  description: "For founders running 1–5 parallel projects in Cursor + Claude Code.",
  nodes: [
    {
      key: "project-1",
      parent: null,
      title: "Project 1 — name me",
      kind: "doc",
      tags: ["product"],
      content_md:
        "# Project 1\n\nOne-liner: _what problem this solves, in one sentence._\n\n## Stack\n- \n\n## Status\n- \n\n## North-star metric\n- ",
    },
    {
      key: "adr-stack",
      parent: "project-1",
      title: "ADR — initial stack",
      kind: "adr",
      tags: ["product"],
      content_md:
        "## Status\nAccepted\n\n## Context\nStarting a new project, need to pick the stack.\n\n## Decision\n_what you chose and why_\n\n## Consequences\n- ",
    },
    {
      key: "blocker-1",
      parent: "project-1",
      title: "Example blocker — replace me",
      kind: "bug",
      tags: ["product"],
      content_md: "_What broke, when, where you got stuck. Keep one open at a time._",
    },
    {
      key: "idea-1",
      parent: null,
      title: "Idea — what's worth building next",
      kind: "doc",
      tags: ["product"],
      content_md: "_Capture the raw idea, the audience, and why now._",
    },
    {
      key: "learning-1",
      parent: null,
      title: "Learning — capture as you go",
      kind: "doc",
      tags: ["tech"],
      content_md: "_A non-obvious lesson worth not forgetting. Link to the decision that triggered it._",
    },
    ...starterSkillNodes(),
  ],
};

const AI_AGENCY: WorkspaceTemplate = {
  id: "ai-agency",
  name: "AI agency (per-client brain)",
  description: "For teams of 3–15 building LLM apps for clients. One workspace per client.",
  nodes: [
    {
      key: "client-profile",
      parent: null,
      title: "Client profile",
      kind: "doc",
      tags: ["business"],
      content_md:
        "# Client\n\n- Name:\n- Industry:\n- Stakeholders:\n- Contract scope:\n- KPIs:\n- Compliance constraints:",
    },
    {
      key: "model-default",
      parent: "client-profile",
      title: "Default model + prompt",
      kind: "doc",
      tags: ["ai"],
      content_md:
        "# Default model + prompt\n\n- Provider/model:\n- Temperature:\n- System prompt (excerpt):\n- Reason for this choice:",
    },
    {
      key: "eval-set-1",
      parent: "model-default",
      title: "Eval set v1",
      kind: "doc",
      tags: ["ai"],
      content_md: "## What this evaluates\n\n## Examples\n\n## Pass criteria\n\n## Current score",
    },
    {
      key: "ticket-onboarding",
      parent: "client-profile",
      title: "Engineer onboarding",
      kind: "task",
      tags: ["business"],
      content_md: "Document the path a new engineer takes from day 1 to first PR. Update weekly.",
    },
    ...starterSkillNodes(),
  ],
};

const STARTUP_FOUNDER: WorkspaceTemplate = {
  id: "startup-founder",
  name: "Startup founder (company brain)",
  description: "For founders building a company brain across all functions.",
  nodes: [
    {
      key: "vision-statement",
      parent: null,
      title: "Vision statement",
      kind: "doc",
      tags: ["business"],
      content_md: "_One paragraph. The world we are building toward, the company we will be in 3 years, and the wedge we use today._",
    },
    {
      key: "metric-northstar",
      parent: "vision-statement",
      title: "North-star metric",
      kind: "doc",
      tags: ["business"],
      content_md: "- Definition:\n- Current value:\n- Target by Q+1:\n- Drivers:\n- Owner:",
    },
    {
      key: "people-team",
      parent: null,
      title: "Team",
      kind: "doc",
      tags: ["business"],
      content_md: "## Founders\n\n## Team\n\n## Advisors\n\n## Hiring next",
    },
    {
      key: "customers-list",
      parent: null,
      title: "Active customers",
      kind: "doc",
      tags: ["business"],
      content_md: "_A row per customer: who they are, what problem we solve for them, contract value, expansion potential._",
    },
    {
      key: "fundraising-status",
      parent: null,
      title: "Round status",
      kind: "doc",
      tags: ["business"],
      content_md: "- Round:\n- Target:\n- Lead status:\n- Closed:\n- Investor list:",
    },
    ...starterSkillNodes(),
  ],
};

export const TEMPLATES: Record<string, WorkspaceTemplate> = {
  [INDIE_HACKER.id]: INDIE_HACKER,
  [AI_AGENCY.id]: AI_AGENCY,
  [STARTUP_FOUNDER.id]: STARTUP_FOUNDER,
};

export function getTemplate(id: string): WorkspaceTemplate | null {
  return TEMPLATES[id] ?? null;
}

export function listTemplates(): WorkspaceTemplate[] {
  return Object.values(TEMPLATES);
}
