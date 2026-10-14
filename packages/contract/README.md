# @bcontext-dev/contract

What bcontext-api and bcontext-web agree on: the node/view/tag types, the
view-query schema, the scope and agent vocabularies, the shapes the API
returns to the UI (`workspaces`, `me`, `activity`, `ingest`, …), the generated
route list the web proxies (`api-proxy`, `api-paths.generated`), and the pure
helpers both sides run (`utils`, `tags`, `env`, `log`, `error-report`).

Nothing in here touches a database, a request, or a framework, and
`apps/api/src/test/contract-is-self-contained.test.ts` enforces it (relative
imports only, every package declared here). Both apps consume it as an npm
workspace from `dist/`, so build it first (`npm run build -w
@bcontext-dev/contract`; the apps' `build`, `test` and `verify` scripts do it
for you). A change that touches API and web lands contract first.
