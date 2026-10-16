FROM caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS caddy
FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920
WORKDIR /app
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy.original
COPY caddy/managed/config.mjs caddy/managed/start.mjs caddy/managed/build-pin.mjs caddy/managed/tls.mjs ./caddy/managed/
COPY packages/shared/runtime/managed-application-headers.mjs packages/shared/runtime/managed-service-mesh.mjs packages/shared/runtime/protected-tls-material.mjs packages/shared/runtime/managed-service-image-pin.mjs packages/shared/runtime/managed-tls-identity.mjs packages/shared/runtime/managed-tls-delivery.mjs ./packages/shared/runtime/
ARG CHARITYPILOT_BUILD_COMMIT
ARG CHARITYPILOT_MANAGED_GATEWAY_BINDING_SHA256
LABEL org.opencontainers.image.revision=$CHARITYPILOT_BUILD_COMMIT
# Re-create the binary bytes without upstream file-capability xattrs. Port10000
# needs no bind capability; retained privileged file caps otherwise cause EPERM
# under the required cap-drop/no-new-privileges runtime boundary.
RUN node caddy/managed/build-pin.mjs && node -e "const fs=require('node:fs');fs.writeFileSync('/usr/bin/caddy',fs.readFileSync('/usr/bin/caddy.original'),{flag:'wx',mode:0o755});fs.unlinkSync('/usr/bin/caddy.original')"
ENV NODE_ENV=production
ENV PORT=10000
ENV XDG_CONFIG_HOME=/tmp/caddy-config
ENV XDG_DATA_HOME=/tmp/caddy-data
USER node
EXPOSE 10000
CMD ["node", "caddy/managed/start.mjs"]
