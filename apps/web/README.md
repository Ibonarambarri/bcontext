# bcontext-web

The web app of Bcontext: the pages, components and shell people use. It
**has no data of its own** — everything lives in the API (`apps/api`), which
this app talks to over HTTP like any other client.

## How it relates to the API

- Every read and write goes to the API as the signed-in person:
  `src/web/api-client.ts` forwards the session cookie on the server, and the
  browser calls `/api/…` relatively — `next.config.mjs` rewrites those (plus
  `/mcp`, `/.well-known/*`, `/install/*`, `/llms.txt`) to `API_ORIGIN`, using
  the route table in `@bcontext-dev/contract`. Behind the bundled Caddy those
  paths go straight to the API; the rewrites cover `npm run dev` and other
  topologies.
- The only Supabase it talks to is **Auth** (`src/web/session.ts`).
- Realtime (presence, live edits) opens a WebSocket to the API at
  `REALTIME_PUBLIC_URL`.
- `src/test/web-speaks-http.test.ts` is the rule as a test: no data module,
  no `.from(`, no `@/api`. When a page needs something the API does not
  offer, the route goes in `apps/api` and the shape in `packages/contract`.

## Configuration at runtime

The image is not tied to a domain. `src/lib/public-env.ts` reads the
Supabase URLs, the anon key, the realtime origin and the Nango hosts from the
server's environment when a request runs, and the browser gets them from
`/env.js` before hydration. `.env.example` lists every variable; `API_ORIGIN`
is the one read at build time (the rewrites), and the Docker build defaults it
to the compose service `http://api:4000`.

## Stack

Next.js 16 (App Router, Turbopack) · TypeScript strict · Tailwind v4 ·
HeroUI v3 (+ the app's own components in `src/components/ui`) · TipTap + Yjs
(editor, collaboration) · sigma (graph). `DESIGN.md` holds the design tokens
and visual rules.

## Development

Start the API and a local Supabase first (`apps/api/docs/ops/local-stack.md`),
then from the repository root:

```bash
npm install
apps/web/scripts/local-env.sh   # .env.development.local from the local stack
npm run dev -w bcontext-web     # http://localhost:3000, API at :4000
```

## Layout

```
src/
  app/            routes: (auth), start, invite, oauth (agent consent),
                  w/[org]/[ws] (the workspace shell), workspaces, admin, docs
  components/     shell, sidebar, editor, views (board/list/graph/browse), nexo,
                  agents, integrations, tools, admin, skeletons…
  web/            api-client (HTTP to the API), session (Supabase Auth), me, workspace
  lib/            client-side helpers: public-env, graph layout/theme, collab, board, settings
  test/           guards, incl. web-speaks-http
scripts/          verify.sh, local-env.sh, perf budgets, glyph generator
```

## Verification

`npm run verify -w bcontext-web` — typecheck, tests, `next build` and the
bundle budgets (`scripts/check-performance-budgets.mjs`); `VERIFY_QUICK=1`
skips the build. CI runs the same script.

The "Getting started" guide (`src/components/onboarding/`) rings real
controls by `data-tour` anchor (`agents-add`, `dashboard-activity`,
`nexo-composer`, `integrations-add`): a change that moves or renames one of
them updates `steps.ts` and `steps.test.ts` in the same PR.
