import { managedApplicationHeaders } from '../../packages/shared/runtime/managed-application-headers.mjs';
import { createManagedServiceMeshBinding } from '../../packages/shared/runtime/managed-service-mesh.mjs';

export const createGatewayBinding = createManagedServiceMeshBinding;
const refuse = () => new Error('Managed gateway configuration refused');

export function gatewayRuntimeBinding(env, build) {
  try {
    if (
      env.NODE_ENV !== 'production' ||
      env.CHARITYPILOT_MANAGED_PROVIDER !== 'render' ||
      env.RENDER_SERVICE_TYPE !== 'web' ||
      env.PORT !== '10000' ||
      typeof env.CHARITYPILOT_MANAGED_GATEWAY_BINDING !== 'string' ||
      Buffer.byteLength(env.CHARITYPILOT_MANAGED_GATEWAY_BINDING) > 8192
    )
      throw refuse();
    const binding = createGatewayBinding(
      JSON.parse(env.CHARITYPILOT_MANAGED_GATEWAY_BINDING),
    );
    const r = binding.record;
    if (
      binding.json !== env.CHARITYPILOT_MANAGED_GATEWAY_BINDING ||
      binding.sha256 !== build?.bindingSha256 ||
      r.sourceSha !== build.sourceSha ||
      env.CHARITYPILOT_BUILD_COMMIT !== r.sourceSha ||
      env.RENDER_SERVICE_ID !== r.gatewayServiceId
    )
      throw refuse();
    return binding;
  } catch {
    throw refuse();
  }
}

export function gatewayConfiguration(env, build, tlsDirectory) {
  try {
    const r = gatewayRuntimeBinding(env, build).record;
    if (
      typeof tlsDirectory !== 'string' ||
      !/^\/tmp\/charitypilot-gateway-[A-Za-z0-9_-]{1,80}$/.test(tlsDirectory)
    )
      throw refuse();
    const host = new URL(r.publicOrigin).host;
    // Discard every unverified client/proxy claim. The remote socket peer is
    // deliberately not labelled as the end-user address behind Render's edge.
    const upstream = (origin) => `reverse_proxy ${origin} {
      header_up Host ${host}
      header_up X-Forwarded-For {http.request.remote.host}
      header_up X-Forwarded-Host ${host}
      header_up X-Forwarded-Proto https
      transport http {
        tls_trust_pool file ${tlsDirectory}/issuer.pem
        tls_client_auth ${tlsDirectory}/client.pem ${tlsDirectory}/client.key
        tls_server_name ${new URL(origin).hostname}
        tls_timeout 5s
        dial_timeout 5s
        response_header_timeout 30s
      }
    }`;
    // route preserves snapshot -> deletion -> conditional restoration ordering.
    // Match stable variables, not headers already removed by the preceding step.
    const capture = managedApplicationHeaders
      .map(
        (name, index) => `vars cp_app_${index} {http.request.header.${name}}`,
      )
      .join('\n');
    const restore = managedApplicationHeaders
      .map(
        (name, index) =>
          `@cp_app_${index} vars_regexp {vars.cp_app_${index}} .+\nrequest_header @cp_app_${index} ${name} {vars.cp_app_${index}}`,
      )
      .join('\n');
    return `{
  admin off
  auto_https off
  persist_config off
  servers {
    timeouts {
      read_header 10s
      read_body 120s
      write 300s
      idle 60s
    }
  }
  log default {
    output stderr
    format filter {
      wrap json
      fields {
        request delete
      }
    }
  }
}
:10000 {
  @health path /healthz
  handle @health {
    header Cache-Control no-store
    respond "gateway-process-only" 200
  }
  @canonical host ${host}
  handle @canonical {
   route {
    ${capture}
    request_header -Forwarded
    request_header -X-Forwarded-*
    request_header -X-Real-IP
    request_header -CF-Connecting-IP
    request_header -True-Client-IP
    request_header -X-CharityPilot-*
    ${restore}
    request_body {
      max_size 64MB
    }
    @api path /api/v1 /api/v1/*
    handle @api {
      ${upstream(r.apiOrigin)}
    }
    handle {
      ${upstream(r.webOrigin)}
    }
   }
  }
  handle {
    respond "Not found" 404
  }
}
`;
  } catch {
    throw refuse();
  }
}
