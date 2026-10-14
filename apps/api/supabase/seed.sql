-- Local development seed. Runs after every migration on `supabase start` /
-- `supabase db reset`, against an EMPTY database — never against production.
--
-- Folderless model: a workspace is organised by tags, not by folder nodes
-- (0045 removed `folder` nodes and the `category` column).
--
-- No users: `auth.users` rows come from signing up through the local Auth
-- service (Inbucket catches the emails). Memberships and grants are written by
-- the app when a person creates or joins a workspace, so seeding them here
-- would bypass the exact code paths local development exists to exercise.

insert into organizations (id, slug, name)
values ('00000000-0000-0000-0000-000000000001', 'demo', 'Demo Org')
on conflict (slug) do nothing;

insert into workspaces (id, organization_id, slug, name, description)
values (
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000001',
  'bcontext',
  'Context OS',
  'Reference workspace demonstrating Bcontext knowledge structure.'
)
on conflict (organization_id, slug) do nothing;

-- A starter taxonomy for the local development workspace.
insert into tags (workspace_id, name, normalized_name, slug, description)
values
  ('00000000-0000-0000-0000-000000000010', 'Business', 'business', 'business', null),
  ('00000000-0000-0000-0000-000000000010', 'Product',  'product',  'product',  null),
  ('00000000-0000-0000-0000-000000000010', 'Tech',     'tech',     'tech',     null),
  ('00000000-0000-0000-0000-000000000010', 'AI',       'ai',       'ai',       null),
  ('00000000-0000-0000-0000-000000000010', 'Research', 'research', 'research',
     'Evidence, audits and investigations; dated research is a snapshot, not automatically current truth.'),
  ('00000000-0000-0000-0000-000000000010', 'Platform & Infrastructure', 'platform & infrastructure', 'platform-infrastructure',
     'Architecture, data plane, hosting, deployments, security, reliability, observability, workers and quality.')
on conflict do nothing;
