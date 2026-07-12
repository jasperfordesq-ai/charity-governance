import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const readFixture = (...pathParts) =>
  readFileSync(join(repoRoot, ...pathParts), 'utf8').replace(/\r\n?/g, '\n');
const compose = readFixture('compose.personal-server.yml');
const caddy = readFixture('caddy', 'Caddyfile.personal-server');
const layout = readFixture('apps', 'web', 'src', 'app', 'layout.tsx');
const exampleEnv = readFixture('.env.personal-server.example');
const turbo = readFixture('turbo.json');
const apiDockerfile = readFixture('apps', 'api', 'Dockerfile');
const webDockerfile = readFixture('apps', 'web', 'Dockerfile');

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
  assert.match(
    serviceSection('db'),
    /image: postgres:16\.4-alpine@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c/,
  );
  assert.match(serviceSection('api'), /target: runner/);
  for (const service of ['migrate', 'api', 'web', 'personal-init']) {
    assert.match(
      serviceSection(service),
      /image: charitypilot-personal-server-(?:migrations|api|web):\$\{CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG:\?Set CHARITYPILOT_PERSONAL_SERVER_IMAGE_TAG in \.env\.personal-server\}/,
      `${service} must use the protected version-bound image tag`,
    );
  }
  assert.doesNotMatch(compose, /charitypilot-personal-server-(?:migrations|api|web):local/);
  const web = serviceSection('web');
  assert.match(web, /target: runner/);
  assert.equal((web.match(/NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: personal-server/g) ?? []).length, 2);
  assert.match(turbo, /"NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE"/);
  assert.match(turbo, /"CHARITYPILOT_DEPLOYMENT_MODE"/);
  assert.match(turbo, /"AUTH_RECOVERY_SECRET"/);
  assert.match(turbo, /"AUTH_DELIVERY_INTERVAL_MS"/);
  assert.match(turbo, /"AUTH_DELIVERY_STALE_SENDING_MS"/);
  assert.match(compose, /name: charitypilot-personal-server-db/);
  assert.match(compose, /name: charitypilot-personal-server-documents/);
  assert.doesNotMatch(compose, /- \.:\/app|C:\\platforms|node_modules:\/app/);
});

test('production application builds use scoped inputs so unrelated app changes stay cached', () => {
  assert.doesNotMatch(apiDockerfile, /^COPY \. \.$/m);
  assert.doesNotMatch(webDockerfile, /^COPY \. \.$/m);
  assert.match(apiDockerfile, /^COPY packages\/shared \.\/packages\/shared$/m);
  assert.match(apiDockerfile, /^COPY apps\/api \.\/apps\/api$/m);
  assert.doesNotMatch(apiDockerfile, /^COPY apps\/web \.\/apps\/web$/m);
  assert.match(webDockerfile, /^COPY packages\/shared \.\/packages\/shared$/m);
  assert.match(webDockerfile, /^COPY apps\/web \.\/apps\/web$/m);
  assert.doesNotMatch(webDockerfile, /^COPY apps\/api \.\/apps\/api$/m);
});

test('third-party infrastructure images are pinned to immutable multi-platform digests', () => {
  assert.match(
    serviceSection('db'),
    /image: postgres:16\.4-alpine@sha256:5660c2cbfea50c7a9127d17dc4e48543eedd3d7a41a595a2dfa572471e37e64c/,
  );
  assert.match(
    serviceSection('document-storage-init'),
    /image: alpine:3\.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc/,
  );
  assert.match(
    serviceSection('caddy'),
    /image: caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648/,
  );
});

test('database and front door run with the least compatible privileges', () => {
  const db = serviceSection('db');
  assert.match(db, /read_only: true/);
  assert.match(db, /\/var\/run\/postgresql:rw,noexec,nosuid,nodev,size=16m/);
  assert.match(db, /cap_drop:\s*- ALL/);
  for (const capability of ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID']) {
    assert.match(db, new RegExp(`- ${capability}`));
  }

  const caddyService = serviceSection('caddy');
  assert.match(caddyService, /user: "1000:1000"/);
  assert.match(caddyService, /cap_add:[\s\S]*?- NET_BIND_SERVICE/);
  assert.match(caddyService, /read_only: true/);
  assert.equal((caddyService.match(/uid=1000,gid=1000,mode=0700/g) ?? []).length, 3);
  assert.match(caddyService, /<<: \*service-security/);
  assert.match(compose, /x-service-security: &service-security\s+security_opt:[\s\S]*?cap_drop:\s*- ALL/);

  const documentStorageInit = serviceSection('document-storage-init');
  assert.match(documentStorageInit, /cap_add:\s+- CHOWN\s+- FOWNER/);
  assert.match(documentStorageInit, /<<: \*service-security/);

  for (const mount of compose.matchAll(/^\s+- (\/[^\n]+:rw[^\n]+)$/gm)) {
    assert.match(mount[1], /(?:^|,)nodev(?:,|$)/, `tmpfs must be nodev: ${mount[1]}`);
  }
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
  assert.match(caddy, /persist_config off/);
  assert.match(caddy, /-Server/);
  assert.match(caddy, /X-CharityPilot-Deployment "personal-server"/);
  assert.match(caddy, /X-Robots-Tag "noindex, nofollow, noarchive"/);
  assert.equal((caddy.match(/api:3002/g) ?? []).length, 1);
});

test('personal-server web rendering does not request Google Fonts', () => {
  assert.match(layout, /shouldLoadExternalWebFonts/);
  assert.match(layout, /process\.env\.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE/);
  assert.match(layout, /\{loadExternalWebFonts \? \(/);
  assert.match(layout, /https:\/\/fonts\.googleapis\.com/);
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

test('recovery-secret rotation receives the configured secret in its maintenance container', () => {
  const rotation = serviceSection('auth-recovery-secret-rotation');
  assert.match(rotation, /profiles:\s*- maintenance/);
  assert.match(rotation, /CHARITYPILOT_DEPLOYMENT_MODE: personal-server/);
  assert.match(
    rotation,
    /AUTH_RECOVERY_SECRET: \$\{AUTH_RECOVERY_SECRET:\?Set AUTH_RECOVERY_SECRET in \.env\.personal-server\}/,
  );
});

test('the internal and Caddy-only edge networks isolate services without trusting spoofable forwarded headers', () => {
  const caddyService = serviceSection('caddy');
  assert.match(caddyService, /personal-server-internal:\s*\n\s+ipv4_address: 172\.30\.250\.10/);
  assert.match(caddyService, /personal-server-edge:\s*\n\s+gw_priority: 1/);
  assert.deepEqual(
    [...caddyService.matchAll(/^\s{6}(personal-server-[a-z-]+):/gm)].map((match) => match[1]).sort(),
    ['personal-server-edge', 'personal-server-internal'],
  );
  for (const service of ['db', 'document-storage-init', 'migrate', 'api', 'web', 'personal-init', 'auth-recovery-secret-rotation']) {
    assert.doesNotMatch(serviceSection(service), /personal-server-edge/, `${service} must remain internal-only`);
  }
  assert.match(compose, /subnet: 172\.30\.250\.0\/24/);
  assert.match(compose, /gateway: 172\.30\.250\.1/);
  assert.match(compose, /personal-server-edge:\s*\n\s+name: charitypilot-personal-server-edge\s*\n\s+driver: bridge\s*\n\s+internal: false/);
  assert.match(compose, /subnet: 172\.30\.251\.0\/24/);
  assert.match(compose, /gateway: 172\.30\.251\.1/);
  assert.doesNotMatch(caddy, /trusted_proxies|client_ip_headers/u);
  assert.match(compose, /TRUSTED_PROXY_ADDRESSES: 172\.30\.250\.10/u);
});
