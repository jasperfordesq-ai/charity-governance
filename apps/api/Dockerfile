FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS migration-deps
WORKDIR /app/apps/api
COPY apps/api/prisma/migration-runner/package.json ./package.json
COPY apps/api/prisma/migration-runner/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --omit=peer --no-audit --no-fund && \
    npm cache clean --force

FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS migration-runner
WORKDIR /app/apps/api
ENV NODE_ENV=production
COPY --chown=node:node --from=migration-deps /app/apps/api/package.json ./package.json
COPY --chown=node:node --from=migration-deps /app/apps/api/package-lock.json ./package-lock.json
COPY --chown=node:node --from=migration-deps /app/apps/api/node_modules ./node_modules
COPY --chown=node:node apps/api/prisma/schema.prisma ./prisma/schema.prisma
COPY --chown=node:node apps/api/prisma/migrations ./prisma/migrations
USER node
ENTRYPOINT ["./node_modules/.bin/prisma"]
CMD ["migrate", "deploy", "--schema", "prisma/schema.prisma"]

FROM deps AS build
WORKDIR /app
ARG DATABASE_URL=postgresql://charitypilot:charitypilot@localhost:5432/charitypilot
ENV DATABASE_URL=$DATABASE_URL
COPY . .
RUN npm run build -w @charitypilot/shared
RUN npm run db:generate -w @charitypilot/api
RUN npm run build -w @charitypilot/api

FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS runtime-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --omit=peer --workspace @charitypilot/api --workspace @charitypilot/shared --include-workspace-root=false && \
    rm -rf node_modules/prisma \
      node_modules/typescript \
      node_modules/.bin/prisma \
      node_modules/.bin/tsc \
      node_modules/.bin/tsserver

FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3002
COPY --chown=node:node --from=build /app/package.json /app/package-lock.json ./
COPY --chown=node:node --from=runtime-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=node:node --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --chown=node:node --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --chown=node:node --from=build /app/apps/api/dist ./apps/api/dist
WORKDIR /app/apps/api
EXPOSE 3002
USER node
CMD ["node", "dist/start.js"]
