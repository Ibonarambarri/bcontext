# bcontext-web: the Next.js app (standalone output). Build from the
# repository root (the contract package lives beside the app):
#
#   docker build -f apps/web/Dockerfile -t bcontext-web .
#
# The image is not tied to a domain: Supabase URL, anon key and realtime
# origin are read at runtime (src/lib/public-env.ts, served as /env.js).

FROM node:24-alpine AS deps
WORKDIR /repo
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
COPY packages/contract/package.json ./packages/contract/
COPY apps/web/package.json ./apps/web/
RUN npm ci -w bcontext-web -w @bcontext-dev/contract --include-workspace-root --no-audit --no-fund

FROM node:24-alpine AS builder
WORKDIR /repo
COPY --from=deps /repo ./
COPY packages/contract ./packages/contract
COPY apps/web ./apps/web
ENV NEXT_TELEMETRY_DISABLED=1
# Where the web app proxies the API routes. Read by next.config.mjs at BUILD
# time (rewrites are baked into the output). `http://api:4000` is the API
# service of the bundled docker-compose.yml; override for other topologies.
ARG API_ORIGIN=http://api:4000
ENV API_ORIGIN=$API_ORIGIN
# Placeholders, build stage only: pages that gate on "is Supabase
# configured?" (admin, auth) must be built as the configured app, i.e. as
# dynamic routes, or Next prerenders their demo-mode 404. The real values
# arrive at runtime and never touch this stage.
ENV SUPABASE_URL=http://supabase.build.invalid
ENV SUPABASE_ANON_KEY=build-placeholder
# The guard after the build fails the image if a placeholder was baked into
# the output. BusyBox grep: exit 1 means "no match" (good); 0 is a leak and 2
# an error, and both must fail the build rather than pass it.
RUN npm run -s build -w @bcontext-dev/contract && npm run build -w bcontext-web \
 && { grep -rlE 'supabase\.build\.invalid|build-placeholder' apps/web/.next/static apps/web/.next/server/app; test $? -eq 1; }

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
# Standalone output mirrors the monorepo (apps/web/server.js plus the traced
# node_modules at the root).
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public
USER nextjs
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
