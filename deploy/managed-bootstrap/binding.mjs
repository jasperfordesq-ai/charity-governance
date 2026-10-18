import { createHash } from 'node:crypto';

const refused = () => new Error('Managed identity bootstrap refused');
export const roles = Object.freeze(['gateway', 'web', 'api', 'scheduler']);
const fields = ['format', 'provider', 'region', 'purpose', 'bootstrapId',
  'installationId', 'ownerId', 'environmentId', 'sourceSha', 'expiresAt', 'names'];
export function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw refused();
}
export function bootstrapBinding(raw, now = Date.now()) {
  try {
    exact(raw, fields);
    const record = Object.fromEntries(fields.map(key => [key, raw[key]]));
    if (record.format !== 1 || record.provider !== 'render' || record.region !== 'frankfurt'
      || record.purpose !== 'SYNTHETIC_IDENTITY_ONLY'
      || typeof record.bootstrapId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.bootstrapId)
      || typeof record.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(record.sourceSha)) throw refused();
    for (const [key, pattern] of [['installationId', /^[a-z0-9][a-z0-9-]{0,62}$/],
      ['ownerId', /^tea-[a-z0-9]{1,64}$/], ['environmentId', /^env-[a-z0-9]{1,64}$/]]) {
      if (typeof record[key] !== 'string' || !pattern.test(record[key])) throw refused();
    }
    if (typeof record.expiresAt !== 'string' || !Number.isSafeInteger(now)
      || new Date(record.expiresAt).toISOString() !== record.expiresAt
      || Date.parse(record.expiresAt) <= now || Date.parse(record.expiresAt) - now > 3600000) throw refused();
    exact(record.names, roles);
    record.names = Object.freeze(Object.fromEntries(roles.map(role => {
      const name = record.names[role];
      if (typeof name !== 'string' || name.length > 63
        || !new RegExp(`^charitypilot(?:-[a-z0-9]+)*-${role}$`).test(name)) throw refused();
      return [role, name];
    })));
    Object.freeze(record);
    const json = JSON.stringify(record);
    return Object.freeze({ record, json,
      sha256: createHash('sha256').update('CHARITYPILOT_MANAGED_IDENTITY_BOOTSTRAP_V1\n' + json).digest('hex') });
  } catch { throw refused(); }
}

export function bootstrapContext(env, pin, now = Date.now()) {
  try {
    const raw = env.CHARITYPILOT_MANAGED_BOOTSTRAP_BINDING;
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw refused();
    const binding = bootstrapBinding(JSON.parse(raw), now), role = env.CHARITYPILOT_MANAGED_BOOTSTRAP_ROLE;
    if (raw !== binding.json || !roles.includes(role)
      || !pin || pin.sourceSha !== binding.record.sourceSha || pin.bindingSha256 !== binding.sha256
      || env.CHARITYPILOT_BUILD_COMMIT !== binding.record.sourceSha
      || !/^srv-[a-z0-9]{20}$/.test(env.RENDER_SERVICE_ID ?? '')
      || env.RENDER_SERVICE_TYPE !== ({ gateway: 'web', web: 'pserv', api: 'pserv', scheduler: 'worker' })[role]
      || env.NODE_ENV !== 'production') throw refused();
    const port = { gateway: 10000, web: 3003, api: 3002, scheduler: null }[role];
    if (env.PORT !== (port === null ? undefined : String(port))) throw refused();
    for (const [key, value] of Object.entries(env)) {
      if (!value) continue;
      if (/^(DATABASE_|JWT_|OWNER_JWT_|AUTH_|SUPABASE_|INTEGRATION_|READINESS_|CONFLUENCE_|AWS_)/i.test(key)
        || /(?:^|_)(?:SECRET|PASSWORD|TOKEN|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY)(?:_|$)/i.test(key)
        || ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(key)) throw refused();
    }
    return Object.freeze({ binding, role, port, lifetimeMs: Date.parse(binding.record.expiresAt) - now });
  } catch { throw refused(); }
}
