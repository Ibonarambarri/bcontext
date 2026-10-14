# Working on Bcontext

Guidance for coding agents (and humans) contributing to this repository.

## Layout

- `apps/api` — Hono API, MCP server (`src/lib/mcp`), permission engine
  (`src/lib/auth`), pg-boss worker (`src/worker`), error collector
  (`src/errors`), Supabase migrations (`supabase/migrations`). One image,
  `BCONTEXT_PROCESS=api|worker|errors`.
- `apps/web` — Next.js app. **No data of its own**: it calls the API over
  HTTP (`src/web/api-client.ts`); the only Supabase it uses is Auth.
- `packages/contract` — `@bcontext-dev/contract`, the types and pure helpers
  both apps share. Depends on nothing outside itself.
- `deploy/`, `docker-compose.yml`, `setup.sh` — the self-hosted stack.

## Rules

- **Verify before you finish**: `npm run verify` at the root (or
  `-w bcontext-api` / `-w bcontext-web` / `-w @bcontext-dev/contract`). CI
  runs the same scripts.
- **Framework-neutral API**: nothing under `apps/api` imports `next/*` or
  React; the bundle builds fail if it does.
- **Routes**: handlers live in `apps/api/src/app/api/**/route.ts`; after
  adding or removing one run `npm run gen:api-routes -w bcontext-api` and
  commit the generated tables (API and contract).
- **Every route opens its workspace through `openWorkspace`** and is scoped
  by the caller's grant; RLS is not the authorisation layer.
- **A change that touches API and web changes the contract first.** The web
  never imports from `apps/api`; `web-speaks-http.test.ts` enforces it.
- **Migrations are append-only**: never edit an existing file in
  `supabase/migrations`; add `NNNN_name.sql` with the next number, wrap it in
  `begin; … commit;`, and check it applies on a fresh database
  (`docker compose down -v && docker compose up -d --build`, watch
  `docker compose logs migrate`).
- **Comments say why**, in prose; every new module starts with a header
  saying what it is, who calls it and what must not break.
- **Docs move with the change**: if you change MCP tools, env variables,
  the compose stack or setup, update the README / `.env.example` in the same
  PR.
- Lockfile: regenerate only with a full `npx npm@11 install` (Node 24's npm),
  never `--package-lock-only`.
