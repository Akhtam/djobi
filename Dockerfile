# One Dockerfile, three stages that matter, selected by docker-compose.yml's `target:` — not one
# Dockerfile per app. A pnpm workspace member (`apps/backend`, `apps/dashboard`) can't be installed
# or built in isolation without either re-installing the whole workspace's dependency graph anyway
# (both depend on `packages/shared`; the dashboard also on `packages/http-client`,
# `packages/profile-editor` and `packages/manual-log`) or reaching for `pnpm deploy`'s isolated-
# subset feature, whose default file inclusion follows `.gitignore` — and `dist/` is gitignored
# (see `.gitignore`), which would silently ship an empty package. One shared `deps`/`build` stage,
# built once, is both simpler to read and actually correct.
#
# The extension is never built here. It cannot run in a container at all — Chrome has to load it
# unpacked from disk on the host — so there is nothing for an image to do with it.

FROM node:22-alpine AS base
# Not `corepack enable`: corepack tries to resolve the exact pnpm version from
# `devEngines.packageManager` in the repo root's package.json, and chokes on that field's version
# being the range `^11.20.0` rather than one exact version — it wants a single pinned version the
# way the older top-level `packageManager` field works, which this repo deliberately doesn't use
# (see the root README's Prerequisites). Installing directly with npm resolves the range the normal
# way and sidesteps that mismatch entirely.
RUN npm install -g pnpm@11
WORKDIR /repo

# Only manifests here, not source — so this layer (and the `pnpm install` below) stays cached across
# a rebuild unless a dependency actually changed. pnpm needs every workspace member's package.json
# present to resolve `pnpm-lock.yaml` against, even ones this image never builds (the extension) —
# leaving one out fails the install, not just wastes cache.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/extension/package.json apps/extension/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/http-client/package.json packages/http-client/package.json
COPY packages/profile-editor/package.json packages/profile-editor/package.json
COPY packages/manual-log/package.json packages/manual-log/package.json
RUN pnpm install --frozen-lockfile

# Now the real source, and the same `pnpm build` CI runs (`.github/workflows/ci.yml`) — one command
# that already means "build every package correctly in dependency order," rather than a
# Docker-specific filter incantation that could quietly drift from what CI actually verifies.
FROM deps AS build
COPY . .
RUN pnpm build
# Removes devDependencies (tsc, vite, vitest, …) from node_modules now that every `dist/` this image
# needs already exists — safe because pnpm prunes in place inside its own tracked node_modules
# rather than reinstalling, so the workspace's symlink graph (apps/backend/node_modules/@djobi/shared
# → packages/shared) survives it. `pnpm prune` has no `-r`/`--recursive` flag — it isn't
# workspace-aware, so every member with its own node_modules needs its own invocation (`-C`).
# `CI=true` is pnpm's own documented way to let `prune` remove a modules directory non-interactively
# — without it, it refuses with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, since a Docker build has
# no TTY to confirm against.
ENV CI=true
RUN pnpm prune --prod \
  && pnpm prune --prod -C apps/backend \
  && pnpm prune --prod -C apps/dashboard \
  && pnpm prune --prod -C apps/extension \
  && pnpm prune --prod -C packages/shared \
  && pnpm prune --prod -C packages/http-client \
  && pnpm prune --prod -C packages/profile-editor \
  && pnpm prune --prod -C packages/manual-log

# The backend: a plain Node process. Carries the whole pruned monorepo tree rather than an isolated
# subset — bigger than the minimum possible image, simple to reason about and to keep correct as the
# workspace's dependency graph changes, which matters more here than shaving image size.
FROM node:22-alpine AS backend
WORKDIR /repo
COPY --from=build /repo .
WORKDIR /repo/apps/backend
# No `NODE_ENV=production`, deliberately. apps/backend/src/auth.ts keys the session cookie's
# `Secure; SameSite=None` on it, but this stack serves the dashboard over plain
# `http://localhost:5174` — Safari refuses a `Secure` cookie on an `http://` origin, so sign-in would
# 200 and the very next request 401. It would also switch on Better Auth's production-only defaults
# (the rate limiter) for what is a local preview. Set it only behind real TLS.
EXPOSE 5391
CMD ["node", "dist/index.js"]

# The dashboard: a static build, served (and reverse-proxied to the backend) by nginx — see
# docker/dashboard.nginx.conf, which mirrors apps/dashboard/vite.config.ts's own dev-server proxy
# list so the two stay one obvious diff apart rather than silently drifting. Built fresh from
# `nginx:alpine`, not from the `backend` stage above: it needs none of that stage's Node runtime or
# pruned node_modules, only the static files vite already emitted.
FROM nginx:1.27-alpine AS dashboard
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html
COPY docker/dashboard.nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
