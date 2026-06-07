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
RUN node -e "try{const url=new URL(process.env.NEXT_PUBLIC_API_URL);const host=url.hostname.toLowerCase();if(url.protocol!=='https:'||url.origin!==process.env.NEXT_PUBLIC_API_URL.replace(/\/+$/,'')||!(host==='charitypilot.ie'||host.endsWith('.charitypilot.ie')))throw new Error();}catch{console.error('NEXT_PUBLIC_API_URL must be an origin-only CharityPilot production URL such as https://api.charitypilot.ie');process.exit(1)}"
RUN npm run build -w @charitypilot/shared
RUN npm run build -w @charitypilot/web

FROM build AS runtime-deps
WORKDIR /app
RUN npm prune --omit=dev --omit=peer --workspaces && \
    rm -rf node_modules/typescript \
      node_modules/eslint \
      node_modules/turbo \
      node_modules/.bin/tsc \
      node_modules/.bin/tsserver \
      node_modules/.bin/eslint \
      node_modules/.bin/turbo

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3003
COPY --chown=node:node --from=build /app/package.json /app/package-lock.json ./
COPY --chown=node:node --from=runtime-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages/shared ./packages/shared
COPY --chown=node:node --from=build /app/apps/web ./apps/web
WORKDIR /app/apps/web
EXPOSE 3003
USER node
CMD ["node", "server.mjs"]
