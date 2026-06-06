FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN case "$NEXT_PUBLIC_API_URL" in https://*) ;; *) echo "NEXT_PUBLIC_API_URL must be set to a production https:// URL"; exit 1 ;; esac
RUN npm run build -w @charitypilot/shared
RUN npm run build -w @charitypilot/web

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3003
COPY --chown=node:node --from=build /app/package.json /app/package-lock.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages/shared ./packages/shared
COPY --chown=node:node --from=build /app/apps/web ./apps/web
WORKDIR /app/apps/web
EXPOSE 3003
USER node
CMD ["node", "server.mjs"]
