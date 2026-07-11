import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const compose = readFileSync(join(repoRoot, 'compose.personal-server.yml'), 'utf8');
const caddy = readFileSync(join(repoRoot, 'caddy', 'Caddyfile.personal-server'), 'utf8');
const exampleEnv = readFileSync(join(repoRoot, '.env.personal-server.example'), 'utf8');
const turbo = readFileSync(join(repoRoot, 'turbo.json'), 'utf8');

function serviceSection(name) {
  const marker = `\n  ${name}:\n`;
  const start = compose.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} service`);
  const bodyStart = start + marker.length;
  const remainder = compose.slice(bodyStart);
  const nextService = remainder.search(/^  [a-z0-9][a-z0-9-]*:\s*$/m);
  return remainder.slice(0, nextService === -1 ? remainder.length : nextService);
}

test('personal server uses isolated release resources without source mounts', () => {
  assert.match(compose, /^name: charitypilot-personal-server$/m);
  assert.match(serviceSection('db'), /image: postgres:16\.4-alpine/);
  assert.match(serviceSection('api'), /target: runner/);
  const web = serviceSection('web');
  assert.match(web, /target: runner/);
  assert.equal((web.match(/NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: personal-server/g) ?? []).length, 2);
  assert.match(turbo, /"NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE"/);
  assert.match(compose, /name: charitypilot-personal-server-db/);
  assert.match(compose, /name: charitypilot-personal-server-documents/);
  assert.doesNotMatch(compose, /- \.:\/app|C:\\platforms|node_modules:\/app/);
});

test('only Caddy publishes the loopback front-door port', () => {
  for (const service of ['db', 'api', 'web']) {
    assert.doesNotMatch(serviceSection(service), /^\s*ports:/m, `${service} must not publish ports`);
  }

  assert.match(
    serviceSection('caddy'),
    /"127\.0\.0\.1:\$\{CHARITYPILOT_PERSONAL_SERVER_PORT:-8080\}:8080"/,
  );
  assert.equal((compose.match(/^\s+ports:/gm) ?? []).length, 1);
});

test('runtime health checks stay on non-redirecting internal login routes', () => {
  const web = serviceSection('web');
  const caddyService = serviceSection('caddy');
  assert.match(web, /http:\/\/127\.0\.0\.1:3003\/login/);
  assert.match(web, /redirect:'manual'/);
  assert.doesNotMatch(web, /127\.0\.0\.1:3003\/['"]/);
  assert.match(caddyService, /http:\/\/127\.0\.0\.1:8080\/login/);
  assert.doesNotMatch(caddyService, /127\.0\.0\.1:8080\/['"]/);
});

test('Caddy exposes only the API v1 prefix and otherwise sends traffic to web', () => {
  assert.match(caddy, /@charitypilot_api path \/api\/v1\/\*/);
  assert.match(caddy, /handle @charitypilot_api \{\s*reverse_proxy api:3002\s*\}/s);
  assert.match(caddy, /handle \{\s*reverse_proxy web:3003\s*\}/s);
  assert.match(caddy, /X-Robots-Tag "noindex, nofollow, noarchive"/);
  assert.equal((caddy.match(/api:3002/g) ?? []).length, 1);
});

test('routine API startup is provider-free and cannot seed', () => {
  const api = serviceSection('api');
  assert.match(api, /environment: \*api-environment/);
  assert.doesNotMatch(api, /migrate:/);
  assert.match(compose, /CHARITYPILOT_DEPLOYMENT_MODE: personal-server/);
  assert.match(compose, /ENABLE_IN_PROCESS_JOBS: "false"/);
  assert.match(compose, /SELF_REGISTRATION_ENABLED: "false"/);
  assert.match(compose, /TRUSTED_PROXY_ADDRESSES: 172\.30\.250\.10/);
  assert.match(compose, /SEED_LOCAL_ADMIN: "false"/);
  assert.match(compose, /SEED_DEMO_WORKSPACE: "false"/);
  assert.doesNotMatch(compose, /STRIPE_|RESEND_|SUPABASE_|ERROR_ALERT_WEBHOOK_URL/);
});

test('personal initialization is explicit, one-shot, and separately configured', () => {
  const migration = serviceSection('migrate');
  const initializer = serviceSection('personal-init');
  assert.match(migration, /profiles:\s*- maintenance\s*- personal-init/);
  assert.match(migration, /restart: "no"/);
  assert.match(initializer, /profiles:\s*- personal-init/);
  assert.match(initializer, /restart: "no"/);
  assert.match(initializer, /node", "dist\/jobs\/initialize-personal-server\.js/);
  assert.match(initializer, /PERSONAL_SERVER_OWNER_PASSWORD: \$\{PERSONAL_SERVER_OWNER_PASSWORD:-\}/);
  assert.match(exampleEnv, /^PERSONAL_SERVER_OWNER_PASSWORD=$/m);
  assert.doesNotMatch(exampleEnv, /^SEED_LOCAL_ADMIN=/m);
});

test('the isolated network pins both application and private-tunnel proxy trust', () => {
  assert.match(serviceSection('caddy'), /ipv4_address: 172\.30\.250\.10/);
  assert.match(compose, /subnet: 172\.30\.250\.0\/24/);
  assert.match(compose, /gateway: 172\.30\.250\.1/);
  assert.match(
    caddy,
    /trusted_proxies static 172\.30\.250\.1\/32 127\.0\.0\.1\/32 ::1\/128/,
  );
  assert.match(caddy, /trusted_proxies_strict/);
  assert.match(caddy, /client_ip_headers X-Forwarded-For/);
});
