# bcontext-api: the API process, the queue worker and the error collector —
# one image, three commands. Build from the repository root (the contract
# package lives beside the app):
#
#   docker build -f apps/api/Dockerfile -t bcontext-api .
#
# No Next, no browser: the web app is apps/web, a separate image.

FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/contract/package.json ./packages/contract/
COPY apps/api/package.json ./apps/api/
RUN npm ci -w bcontext-api -w @bcontext-dev/contract --include-workspace-root --no-audit --no-fund
COPY packages/contract ./packages/contract
COPY apps/api ./apps/api
# build = contract (dist for the workspace link) + api.cjs + worker.cjs +
# errors.cjs, each a self-contained bundle. All three builds fail if anything in
# their import graph reaches next/* or react — the no-Next rule, enforced here.
RUN npm run build -w bcontext-api

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 bcontext
COPY --from=build --chown=bcontext:nodejs /repo/apps/api/dist/api.cjs ./api.js
COPY --from=build --chown=bcontext:nodejs /repo/apps/api/dist/worker.cjs ./worker.js
COPY --from=build --chown=bcontext:nodejs /repo/apps/api/dist/errors.cjs ./errors.js
COPY --from=build --chown=bcontext:nodejs /repo/apps/api/package.json ./package.json
# `GET /install/mcp` streams this file from disk at request time (the curl |
# node one-liner the web shows when creating an agent token); without it the
# route answers 500.
COPY --from=build --chown=bcontext:nodejs /repo/apps/api/scripts/install-mcp.mjs ./scripts/install-mcp.mjs
USER bcontext
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENV API_PORT=4000
EXPOSE 4000
# Three processes from this one image, told apart by BCONTEXT_PROCESS:
#     api     (default)  node api.js     liveness /healthz, health /api/health, WebSockets on /realtime
#     worker             node worker.js  needs DATABASE_URL (direct, session-mode Postgres)
#     errors             node errors.js  POST /ingest on ERRORS_PORT (4100)
# An env var rather than a command so any orchestrator that only lets you set
# environment (not the start command) can still run all three.
CMD ["sh", "-c", "exec node ${BCONTEXT_PROCESS:-api}.js"]
