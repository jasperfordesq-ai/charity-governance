import { createHash } from 'node:crypto';

const fields = [
  'format',
  'provider',
  'region',
  'installationId',
  'ownerId',
  'environmentId',
  'sourceSha',
  'publicOrigin',
  'gatewayServiceId',
  'webServiceId',
  'apiServiceId',
  'schedulerServiceId',
  'apiServiceName',
  'apiOrigin',
  'webServiceName',
  'webOrigin',
];
const refuse = () => new Error('Managed gateway configuration refused');

function internalAddress(origin, name, kind, port) {
  if (
    typeof name !== 'string' ||
    !new RegExp(`^charitypilot(?:-[a-z0-9]+)*-${kind}$`).test(name) ||
    typeof origin !== 'string' ||
    origin.length > 256
  )
    throw refuse();
  const url = new URL(origin),
    prefix = name + '-';
  if (
    url.protocol !== 'http:' ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.port !== String(port) ||
    url.hostname.length > 63 ||
    !url.hostname.startsWith(prefix) ||
    !/^[a-z0-9]{4,20}$/.test(url.hostname.slice(prefix.length)) ||
    url.hostname.endsWith('-discovery')
  )
    throw refuse();
  return url.host;
}

export function createGatewayBinding(raw) {
  try {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join('|') !== [...fields].sort().join('|')
    )
      throw refuse();
    const record = Object.fromEntries(fields.map((key) => [key, raw[key]]));
    if (
      record.format !== 1 ||
      record.provider !== 'render' ||
      record.region !== 'frankfurt' ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(record.installationId) ||
      !/^[a-z][a-z0-9-]{1,99}$/.test(record.ownerId) ||
      !/^[a-z][a-z0-9-]{1,99}$/.test(record.environmentId) ||
      !/^[a-f0-9]{40}$/.test(record.sourceSha)
    )
      throw refuse();
    for (const key of [
      'installationId',
      'ownerId',
      'environmentId',
      'sourceSha',
    ]) {
      if (typeof record[key] !== 'string') throw refuse();
    }
    const ids = [
      'gatewayServiceId',
      'webServiceId',
      'apiServiceId',
      'schedulerServiceId',
    ].map((key) => record[key]);
    if (
      ids.some(
        (id) => typeof id !== 'string' || !/^srv-[a-z0-9]{20}$/.test(id),
      ) ||
      new Set(ids).size !== 4
    )
      throw refuse();
    if (
      typeof record.publicOrigin !== 'string' ||
      record.publicOrigin.length > 512
    )
      throw refuse();
    const front = new URL(record.publicOrigin);
    if (
      front.protocol !== 'https:' ||
      front.origin !== record.publicOrigin ||
      front.username ||
      front.password ||
      front.port ||
      !front.hostname.includes('.') ||
      /^[\d.]+$/.test(front.hostname) ||
      !/^[a-z0-9.-]+$/.test(front.hostname)
    )
      throw refuse();
    internalAddress(record.apiOrigin, record.apiServiceName, 'api', 3002);
    internalAddress(record.webOrigin, record.webServiceName, 'web', 3003);
    const json = JSON.stringify(record);
    return {
      record,
      json,
      sha256: createHash('sha256')
        .update('CHARITYPILOT_MANAGED_GATEWAY_V1\n' + json)
        .digest('hex'),
    };
  } catch {
    throw refuse();
  }
}

export function gatewayConfiguration(env, build) {
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
    const host = new URL(r.publicOrigin).host;
    // Discard every unverified client/proxy claim. The remote socket peer is
    // deliberately not labelled as the end-user address behind Render's edge.
    const upstream = (
      origin,
      name,
      kind,
      port,
    ) => `reverse_proxy ${internalAddress(origin, name, kind, port)} {
      header_up Host ${host}
      header_up X-Forwarded-For {http.request.remote.host}
      header_up X-Forwarded-Host ${host}
      header_up X-Forwarded-Proto https
      transport http {
        dial_timeout 5s
        response_header_timeout 30s
      }
    }`;
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
    request_header -Forwarded
    request_header -X-Forwarded-*
    request_header -X-Real-IP
    request_header -CF-Connecting-IP
    request_header -True-Client-IP
    request_header -X-CharityPilot-*
    request_body {
      max_size 64MB
    }
    @api path /api/v1 /api/v1/*
    handle @api {
      ${upstream(r.apiOrigin, r.apiServiceName, 'api', 3002)}
    }
    handle {
      ${upstream(r.webOrigin, r.webServiceName, 'web', 3003)}
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
