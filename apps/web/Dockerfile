FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS deps
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
ARG NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
RUN node -e "function requireOrigin(name,validateHost,message){try{const value=process.env[name];const url=new URL(value);if(url.protocol!=='https:'||url.origin!==value.replace(/\/+$/,'')||!validateHost(url.hostname.toLowerCase()))throw new Error();}catch{console.error(message);process.exit(1)}}requireOrigin('NEXT_PUBLIC_API_URL',(host)=>host==='api.charitypilot.ie','NEXT_PUBLIC_API_URL must be an origin-only CharityPilot production URL and must use the canonical API origin https://api.charitypilot.ie');requireOrigin('NEXT_PUBLIC_SUPABASE_URL',(host)=>host.endsWith('.supabase.co'),'NEXT_PUBLIC_SUPABASE_URL must be an origin-only HTTPS Supabase project URL such as https://project-ref.supabase.co')"
RUN npm run build -w @charitypilot/shared
RUN npm run build -w @charitypilot/web
RUN rm -rf apps/web/.next/cache \
    apps/web/.next/export \
    apps/web/.next/export-detail.json \
    apps/web/.next/server/proxy.js \
    apps/web/.next/server/proxy.js.nft.json

FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS runtime-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --omit=peer --workspace @charitypilot/web --workspace @charitypilot/shared --include-workspace-root=false && \
    rm -rf node_modules/typescript \
      node_modules/eslint \
      node_modules/turbo \
      node_modules/.bin/tsc \
      node_modules/.bin/tsserver \
      node_modules/.bin/eslint \
      node_modules/.bin/turbo

FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3003
COPY --chown=node:node --from=build /app/package.json /app/package-lock.json ./
COPY --chown=node:node --from=runtime-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --chown=node:node --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --chown=node:node --from=build /app/apps/web/server.mjs ./apps/web/server.mjs
COPY --chown=node:node --from=build /app/apps/web/next.config.ts ./apps/web/next.config.ts
COPY --chown=node:node --from=build /app/apps/web/.next ./apps/web/.next
WORKDIR /app/apps/web
EXPOSE 3003
USER node
CMD ["node", "server.mjs"]
