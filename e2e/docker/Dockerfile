FROM postgres:16.4-alpine@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c AS database

COPY e2e/docker/init-disposable-database.sql /docker-entrypoint-initdb.d/10-charitypilot-e2e-identity.sql
RUN chmod 0444 /docker-entrypoint-initdb.d/10-charitypilot-e2e-identity.sql

FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS gateway

WORKDIR /gateway
COPY --chown=root:root --chmod=0444 e2e/docker/tcp-gateway.mjs /gateway/tcp-gateway.mjs
USER node

FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS app-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --include=dev --no-audit --no-fund

FROM app-dependencies AS app

# The runner's positive allow-list copier constructs this context before Docker
# is invoked. This in-image assertion independently rejects any forbidden host
# env, backup, evidence, agent or VCS path if the copier ever regresses.
COPY --chown=node:node . .
RUN set -eu; \
    forbidden="$(find . -mindepth 1 \
      -type d -name 'node_modules' -prune -o \( \
      -name '.git' -o \
      -name '.env' -o \
      -name '.env.*' -o \
      -name '.charitypilot-backups' -o \
      -name '.charitypilot-launch-evidence' -o \
      -name '.charitypilot-local-storage' -o \
      -name '.charitypilot-readiness-test-storage' -o \
      -name '.agents' -o \
      -name '.claude' -o \
      -name '.codex' -o \
      -name '.codex-*' -o \
      -name 'production-launch-evidence*.json' \
    \) -print -quit)"; \
    if [ -n "$forbidden" ]; then \
      echo 'Forbidden private path entered the isolated E2E build context.' >&2; \
      exit 1; \
    fi
RUN npm run build -w @charitypilot/shared && \
    npm run db:generate -w @charitypilot/api && \
    NODE_ENV=production \
      NEXT_PUBLIC_API_URL=http://127.0.0.1:3302 \
      NEXT_PUBLIC_CHARITYPILOT_E2E_MODE=local-disposable \
      npm run build -w @charitypilot/web && \
    test -s apps/web/.next/BUILD_ID && \
    rm -rf apps/web/.next/cache && \
    test ! -e apps/web/.next/cache

ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
USER node
