FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM deps AS build
WORKDIR /app
ARG DATABASE_URL=postgresql://charitypilot:charitypilot@localhost:5432/charitypilot
ENV DATABASE_URL=$DATABASE_URL
COPY . .
RUN npm run build -w @charitypilot/shared
RUN npm run db:generate -w @charitypilot/api
RUN npm run build -w @charitypilot/api

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3002
COPY --chown=node:node --from=build /app/package.json /app/package-lock.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages/shared ./packages/shared
COPY --chown=node:node --from=build /app/apps/api ./apps/api
WORKDIR /app/apps/api
EXPOSE 3002
USER node
CMD ["node", "dist/start.js"]
