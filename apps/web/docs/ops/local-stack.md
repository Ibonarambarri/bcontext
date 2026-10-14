# Local stack (web)

The database and the API process start from `apps/api` (`supabase
start`, `node dist/api.cjs` on :4000 — see `apps/api/docs/ops/local-stack.md`).
This repo only needs to know where they are:

```sh
./scripts/local-env.sh   # writes .env.development.local: local Supabase Auth, API_ORIGIN=http://localhost:4000
npm run dev              # :3000, proxying /api/* and /mcp to :4000
```

`node scripts/session-cookie.mjs someone@example.com` prints a Cookie header
for a signed-in local user, so a server-rendered page can be fetched with
`curl -H "cookie: …"` as that person.
