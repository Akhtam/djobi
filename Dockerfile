# One Dockerfile with stages selected by docker-compose.yml's `target:`. Workspace members can't be
# built in isolation without reinstalling the whole graph (and `pnpm deploy` follows `.gitignore`,
# which excludes `dist/`), so one shared deps/build stage serves every image.
#
# The extension isn't built here: Chrome loads it unpacked from the host.

FROM node:22-alpine AS base
# Not `corepack enable`: corepack wants an exact pnpm version, but `devEngines.packageManager` is a
# range. Installing with npm resolves the range normally.
RUN npm install -g pnpm@11
WORKDIR /repo

# Manifests only, so the install layer stays cached until dependencies change. Every workspace
# member's package.json is required to resolve the lockfile, even the extension's.
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

# The same `pnpm build` CI runs, so the image can't drift from what CI verifies.
FROM deps AS build
COPY . .
RUN pnpm build
# Drop devDependencies now that every `dist/` exists. `pnpm prune` isn't workspace-aware, so each
# member is pruned with `-C`; `CI=true` lets it remove modules without a TTY.
ENV CI=true
RUN pnpm prune --prod \
  && pnpm prune --prod -C apps/backend \
  && pnpm prune --prod -C apps/dashboard \
  && pnpm prune --prod -C apps/extension \
  && pnpm prune --prod -C packages/shared \
  && pnpm prune --prod -C packages/http-client \
  && pnpm prune --prod -C packages/profile-editor \
  && pnpm prune --prod -C packages/manual-log

# The backend: a plain Node process over the whole pruned tree — simpler to keep correct than an
# isolated subset.
FROM node:22-alpine AS backend
WORKDIR /repo
COPY --from=build /repo .
WORKDIR /repo/apps/backend
# No `NODE_ENV=production`: it makes session cookies `Secure; SameSite=None`, which Safari won't
# store over this stack's plain `http://localhost`, and enables production-only rate limiting. Set
# it only behind real TLS.
EXPOSE 5391
CMD ["node", "dist/index.js"]

# The dashboard: static files served by nginx, which also proxies the backend
# (docker/dashboard.nginx.conf mirrors vite.config.ts's dev proxy). Needs no Node runtime.
FROM nginx:1.27-alpine AS dashboard
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html
COPY docker/dashboard.nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
