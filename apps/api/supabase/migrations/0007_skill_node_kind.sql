-- 0007_skill_node_kind.sql
--
-- Extend the `nodes.kind` check constraint to include `skill`.
--
-- A skill node represents a reusable agent capability (Anthropic Agent
-- Skills format: SKILL.md with `name` / `description` frontmatter plus a
-- prompt body). The P1-07 AGENTS.md / CLAUDE.md / cursor-rules generator
-- (`src/lib/skills/generate.ts`) already parses skill-shaped nodes by
-- frontmatter, regardless of kind. Promoting `skill` to a first-class
-- kind lets the sidebar render a distinctive icon and the generator
-- bias its filter to this kind when callers prefer scope-by-kind.
--
-- Backwards compatible: existing skill-shaped nodes seeded as `doc`
-- under the "Skills" folder continue to work — the generator filters
-- by frontmatter, not by kind. Migration to `kind = 'skill'` can be
-- done lazily, per-workspace, as users opt in.
--
-- This migration replaces the check constraint added in 0001_init.sql.
-- Postgres doesn't support `ALTER CHECK`, so we drop and re-add.

alter table nodes
  drop constraint if exists nodes_kind_check;

alter table nodes
  add constraint nodes_kind_check
  check (kind in (
    'folder','doc','task','decision','meeting','bug','adr','entity','skill'
  ));
