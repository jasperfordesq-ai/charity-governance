FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920
WORKDIR /app
COPY deploy/managed-bootstrap/binding.mjs deploy/managed-bootstrap/start.mjs deploy/managed-bootstrap/entrypoint.sh ./deploy/managed-bootstrap/
COPY packages/shared/runtime/managed-service-image-pin.mjs packages/shared/runtime/protected-tls-material.mjs ./packages/shared/runtime/
ARG CHARITYPILOT_BUILD_COMMIT
ARG CHARITYPILOT_MANAGED_BOOTSTRAP_BINDING_SHA256
RUN node --input-type=module -e 'import fs from "node:fs"; import {parseManagedServiceImagePin} from "./packages/shared/runtime/managed-service-image-pin.mjs"; const raw=JSON.stringify({format:1,sourceSha:process.env.CHARITYPILOT_BUILD_COMMIT,bindingSha256:process.env.CHARITYPILOT_MANAGED_BOOTSTRAP_BINDING_SHA256})+"\n"; parseManagedServiceImagePin(raw,true); fs.mkdirSync("/opt/charitypilot",{mode:0o755}); fs.writeFileSync("/opt/charitypilot/managed-bootstrap-build.json",raw,{mode:0o444,flag:"wx"});'
ENV NODE_ENV=production
USER node
ENTRYPOINT ["/bin/sh", "/app/deploy/managed-bootstrap/entrypoint.sh"]
CMD ["node", "deploy/managed-bootstrap/start.mjs"]
