import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const readFixture = (...pathParts) =>
  readFileSync(join(repoRoot, ...pathParts), 'utf8').replace(/\r\n?/g, '\n');
const compose = readFixture('compose.bluegreen.yml');
const caddy = readFixture('caddy', 'Caddyfile.bluegreen');
const activeUpstreamsExample = readFixture('caddy', 'active-upstreams.example.caddy');
const personalServerCompose = readFixture('compose.personal-server.yml');
const personalServerCaddy = readFixture('caddy', 'Caddyfile.personal-server');
const productionCaddy = readFixture('caddy', 'Caddyfile');
const productionCompose = readFixture('compose.production.yml');
const gitignore = readFixture('.gitignore');
const DOCKER_COMPOSE_CONFIG_TIMEOUT_MS = 120_000;

function serviceSection(name) {
  const marker = `\n  ${name}:\n`;
  const start = compose.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} service`);
  const bodyStart = start + marker.length;
  const remainder = compose.slice(bodyStart);
  const nextService = remainder.search(/^  [a-z0-9][a-z0-9-]*:\s*$/m);
  return remainder.slice(0, nextService === -1 ? remainder.length : nextService);
}

test('the blue-green compose file declares colour-scoped profiles for api and web only', () => {
  assert.match(serviceSection('api-blue'), /profiles:\s*\n\s+- blue\s*\n/);
  assert.match(serviceSection('web-blue'), /profiles:\s*\n\s+- blue\s*\n/);
  assert.match(serviceSection('api-green'), /profiles:\s*\n\s+- green\s*\n/);
  assert.match(serviceSection('web-green'), /profiles:\s*\n\s+- green\s*\n/);

  for (const service of [
    'db',
    'caddy',
    'scheduler',
    'deadline-reminders',
    'document-storage-cleanup',
    'auth-recovery-secret-rotation',
    'migrate',
  ]) {
    assert.doesNotMatch(serviceSection(service), /^\s*profiles:/m, `${service} must be a singleton with no profile`);
  }
});

test('api and web build from repo context with the existing Dockerfiles and colour-tagged images', () => {
  for (const [color, svc, dockerfile] of [
    ['BLUE', 'api-blue', 'apps/api/Dockerfile'],
    ['GREEN', 'api-green', 'apps/api/Dockerfile'],
    ['BLUE', 'web-blue', 'apps/web/Dockerfile'],
    ['GREEN', 'web-green', 'apps/web/Dockerfile'],
  ]) {
    const section = serviceSection(svc);
    const kind = svc.startsWith('api') ? 'api' : 'web';
    assert.match(section, new RegExp(`image: charitypilot-bluegreen-${kind}:\\$\\{BLUEGREEN_${color}_TAG:\\?`));
    assert.match(section, /build:\s*\n\s+context: \.\s*\n\s+dockerfile: /);
    assert.match(section, new RegExp(dockerfile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(section, /target: runner/);
    assert.match(
      section,
      new RegExp(`CHARITYPILOT_BUILD_COMMIT: \\$\\{BLUEGREEN_${color}_TAG:\\?`),
      `${svc} build arg must pass CHARITYPILOT_BUILD_COMMIT from BLUEGREEN_${color}_TAG`,
    );
  }
});

test('web build args bake the single front-door origin into NEXT_PUBLIC_API_URL', () => {
  for (const svc of ['web-blue', 'web-green']) {
    const section = serviceSection(svc);
    assert.match(section, /NEXT_PUBLIC_API_URL: \$\{BLUEGREEN_ORIGIN:\?/);
    // The runtime environment must carry the identical value used at build time.
    const buildArgValue = section.match(/args:[\s\S]*?NEXT_PUBLIC_API_URL: (\$\{BLUEGREEN_ORIGIN:\?[^}]*\})/);
    const envValue = section.match(/environment:[\s\S]*?NEXT_PUBLIC_API_URL: (\$\{BLUEGREEN_ORIGIN:\?[^}]*\})/);
    assert.ok(buildArgValue, `${svc} must set NEXT_PUBLIC_API_URL as a build arg`);
    assert.ok(envValue, `${svc} must set NEXT_PUBLIC_API_URL as a runtime env var`);
    assert.equal(buildArgValue[1], envValue[1]);
  }
});

test('web build args also widen the Dockerfile origin check via the canonical-API-origin override', () => {
  for (const svc of ['web-blue', 'web-green']) {
    const section = serviceSection(svc);
    const canonicalArg = section.match(
      /args:[\s\S]*?NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN: (\$\{BLUEGREEN_ORIGIN:\?[^}]*\})/,
    );
    const originArg = section.match(/args:[\s\S]*?NEXT_PUBLIC_API_URL: (\$\{BLUEGREEN_ORIGIN:\?[^}]*\})/);
    assert.ok(
      canonicalArg,
      `${svc} must pass NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN as a build arg (widens the Dockerfile's hosted-only origin check)`,
    );
    assert.ok(originArg, `${svc} must pass NEXT_PUBLIC_API_URL as a build arg`);
    assert.equal(
      canonicalArg[1],
      originArg[1],
      `${svc}: the canonical-API-origin override must equal the same BLUEGREEN_ORIGIN used for NEXT_PUBLIC_API_URL (one-origin topology)`,
    );
  }
});

test('the canonical-API-origin override also reaches the runner as a real runtime env var, not just a build arg', () => {
  for (const svc of ['web-blue', 'web-green']) {
    const section = serviceSection(svc);
    // validateProductionApiUrl (apps/web/src/lib/api-config.ts) is called with
    // a default parameter of the live process.env at request time, so the
    // override must be a genuine runtime environment variable in the running
    // container — a build arg alone never reaches it (build args only affect
    // the docker build, not the container's runtime environment).
    const buildArgValue = section.match(
      /args:[\s\S]*?NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN: (\$\{BLUEGREEN_ORIGIN:\?[^}]*\})/,
    );
    const envValue = section.match(
      /environment:[\s\S]*?NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN: (\$\{BLUEGREEN_ORIGIN:\?[^}]*\})/,
    );
    assert.ok(buildArgValue, `${svc} must set NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN as a build arg`);
    assert.ok(envValue, `${svc} must set NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN as a runtime env var`);
    assert.equal(buildArgValue[1], envValue[1]);
  }
});

test("each web colour pins its internal API hop to its OWN colour's api service, not the other colour's", () => {
  for (const [svc, expectedApiColour] of [
    ['web-blue', 'blue'],
    ['web-green', 'green'],
  ]) {
    const section = serviceSection(svc);
    // The front-door override (NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN)
    // is unreachable from inside the container network, so server-to-server
    // calls must be pinned to this colour's own api-<colour> service — see
    // apps/web/src/lib/api-config.ts's validateServerApiUrl. Colour-matched,
    // not cross-colour, so a candidate's public smoke exercises its own api.
    const internalUrl = section.match(/environment:[\s\S]*?CHARITYPILOT_INTERNAL_API_URL: (http:\/\/api-[a-z]+:3002)/);
    assert.ok(internalUrl, `${svc} must set CHARITYPILOT_INTERNAL_API_URL as a runtime env var`);
    assert.equal(internalUrl[1], `http://api-${expectedApiColour}:3002`, `${svc} must pin to its OWN colour's api service`);
  }
});

test('no api or web service publishes a host port; Caddy proxies by container DNS name', () => {
  for (const service of ['api-blue', 'api-green', 'web-blue', 'web-green']) {
    assert.doesNotMatch(serviceSection(service), /^\s*ports:/m, `${service} must not publish ports`);
  }
  assert.match(
    serviceSection('caddy'),
    /"127\.0\.0\.1:\$\{BLUEGREEN_FRONT_PORT:-8080\}:8080"/,
  );
  assert.equal((compose.match(/^\s+ports:/gm) ?? []).length, 1);
});

test('api and web services each carry a healthcheck', () => {
  for (const service of ['api-blue', 'api-green', 'web-blue', 'web-green']) {
    assert.match(serviceSection(service), /healthcheck:/, `${service} must define a healthcheck`);
  }
});

test('api services disable in-process jobs so the singleton scheduler/jobs own that work', () => {
  assert.match(serviceSection('api-blue'), /ENABLE_IN_PROCESS_JOBS: "false"/);
  assert.match(serviceSection('api-green'), /ENABLE_IN_PROCESS_JOBS: "false"/);
});

test('scheduler and job singletons mirror compose.production.yml but run the local build image', () => {
  const productionScheduler = productionCompose.match(/\n {2}production-scheduler:\n([\s\S]*?)\n {2}[a-z]/)[1];
  const productionDeadline = productionCompose.match(/\n {2}deadline-reminders:\n([\s\S]*?)\n {2}[a-z]/)[1];
  const productionCleanup = productionCompose.match(/\n {2}document-storage-cleanup:\n([\s\S]*?)\n {2}[a-z]/)[1];
  const productionRotation = productionCompose.match(/\n {2}auth-recovery-secret-rotation:\n([\s\S]*?)\n {2}[a-z]/)[1];

  assert.match(productionScheduler, /production-scheduler\.js/);
  assert.match(productionDeadline, /send-deadline-reminders\.js/);
  assert.match(productionCleanup, /cleanup-document-storage\.js/);
  assert.match(productionRotation, /rotate-auth-recovery-secret\.js/);

  const scheduler = serviceSection('scheduler');
  const deadline = serviceSection('deadline-reminders');
  const cleanup = serviceSection('document-storage-cleanup');
  const rotation = serviceSection('auth-recovery-secret-rotation');

  assert.match(scheduler, /command: \["node", "dist\/jobs\/production-scheduler\.js"\]/);
  assert.match(deadline, /command: \["node", "dist\/jobs\/send-deadline-reminders\.js"\]/);
  assert.match(cleanup, /command: \["node", "dist\/jobs\/cleanup-document-storage\.js"\]/);
  assert.match(rotation, /command: \["node", "dist\/jobs\/rotate-auth-recovery-secret\.js"\]/);

  for (const section of [scheduler, deadline, cleanup, rotation]) {
    assert.match(section, /image: charitypilot-bluegreen-api:\$\{BLUEGREEN_ACTIVE_TAG:\?/);
    assert.doesNotMatch(section, /\n\s+build:/, 'singleton jobs must reuse the api image, not build it again');
  }
  assert.match(scheduler, /restart: unless-stopped/);
  for (const section of [deadline, cleanup, rotation]) {
    assert.match(section, /restart: "no"/);
  }
});

test('the one-shot migrate runner builds the migration-runner target and never mounts host ports', () => {
  const migrate = serviceSection('migrate');
  assert.match(migrate, /image: charitypilot-bluegreen-migrations:\$\{BLUEGREEN_ACTIVE_TAG:\?/);
  assert.match(migrate, /build:\s*\n\s+context: \.\s*\n\s+dockerfile: apps\/api\/Dockerfile\s*\n\s+target: migration-runner/);
  assert.match(migrate, /restart: "no"/);
  assert.doesNotMatch(migrate, /^\s*ports:/m);
});

test('every service needing runtime configuration reads it from the deployment env file', () => {
  for (const service of [
    'db',
    'api-blue',
    'api-green',
    'web-blue',
    'web-green',
    'migrate',
    'scheduler',
    'deadline-reminders',
    'document-storage-cleanup',
    'auth-recovery-secret-rotation',
  ]) {
    assert.match(
      serviceSection(service),
      /env_file: \$\{BLUEGREEN_ENV_FILE:\?/,
      `${service} must read env_file from BLUEGREEN_ENV_FILE`,
    );
  }
});

test('named volumes are plain (not external) with a comment reserving the P3 override seam', () => {
  assert.match(compose, /\nvolumes:\s*\n\s+bluegreen-db:\s*\n\s+name: charitypilot-bluegreen-db\s*\n\s+bluegreen-documents:\s*\n\s+name: charitypilot-bluegreen-documents/);
  assert.doesNotMatch(compose, /external: true/);
  assert.match(compose, /P3, the VM cutover\) swaps[\s\S]{0,20}in the appliance's own EXTERNAL volumes/);
  assert.match(compose, /NEVER by editing this file/);
});

test('Caddy listens on :8080 inside the network, published on the configurable front port, importing generated upstreams', () => {
  const caddyService = serviceSection('caddy');
  assert.match(
    caddyService,
    /"127\.0\.0\.1:\$\{BLUEGREEN_FRONT_PORT:-8080\}:8080"/,
  );
  assert.match(caddyService, /\.\/caddy\/Caddyfile\.bluegreen:\/etc\/caddy\/Caddyfile:ro/);
  assert.match(caddyService, /\.\/caddy\/active-upstreams\.caddy:\/etc\/caddy\/active-upstreams\.caddy:ro/);
  assert.match(
    caddyService,
    /image: caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648/,
  );
  assert.match(personalServerCompose, /caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648/);

  assert.match(caddy, /^:8080 \{/m);
  assert.match(caddy, /import \/etc\/caddy\/active-upstreams\.caddy/);
});

test('Caddyfile.bluegreen shares auto_https/persist_config with personal-server but deliberately diverges on admin', () => {
  // Both still turn off automatic HTTPS and config persistence identically.
  // Both assertions used to end at the global block's closing brace. The
  // global block now also carries the `log default` filter (the F1 fix, pinned
  // by 'every Caddyfile filters the default logger' below), so they end at
  // that block instead: the three switches stay pinned in the same order, and
  // the default logger is additionally required to exist.
  assert.match(
    caddy,
    /^\{\s*\n[\s\S]*?\n\s+auto_https off\s*\n\s+persist_config off\s*\n[\s\S]*?\n\tlog default \{/m,
  );
  assert.match(
    personalServerCaddy,
    /^\{\s*\n\s+admin off\s*\n\s+auto_https off\s*\n\s+persist_config off\s*\n[\s\S]*?\n\tlog default \{/m,
  );
  assert.match(caddy, /encode zstd gzip/);

  // Deliberate divergence (fix round 3): personal-server keeps `admin off`
  // (it never runs a zero-downtime `caddy reload`), but blue-green's
  // switch/rollback cutover needs a live admin API to reload into — see
  // scripts/bluegreen-deploy.mjs. `admin off` here would make every
  // deploy's reload fail deterministically at the switch phase.
  assert.doesNotMatch(caddy, /^\s*admin off\s*$/m, 'blue-green must NOT use admin off — reload needs a live admin API');
  assert.match(caddy, /^\tadmin unix\/\/tmp\/caddy-admin\.sock\s*$/m, 'blue-green admin directive must be exactly the unix-socket form');

  // The admin API must never be reachable over TCP (no port to publish, no
  // network exposure) — only the container-local unix socket above.
  assert.doesNotMatch(caddy, /admin\s+(tcp\/|localhost:2019|127\.0\.0\.1:2019|0\.0\.0\.0:2019)/);
  assert.doesNotMatch(caddy, /:2019\b/);
});

// ---------------------------------------------------------------------------
// The OAuth callback's query string must not reach the proxy access log.
//
// apps/api/src/utils/logger.ts censors `code` and `state` out of the API's own
// log, but Caddy's JSON access log records `request.uri` INCLUDING the query
// string and both Caddyfiles proxy /api/*. Without the `filter` encoder below,
// the single-use authorization code and the CSRF state land in the container
// log — the same leak, one layer further out, and in the log an operator is
// most likely to `docker logs` and paste into a ticket.
//
// This test exists so the filter cannot be removed as noise by someone tidying
// a Caddyfile, which is exactly how it would go.
// ---------------------------------------------------------------------------
test('both Caddyfiles strip the OAuth code and state from the access log', () => {
  for (const [name, config] of [
    ['Caddyfile.bluegreen', caddy],
    ['Caddyfile.personal-server', personalServerCaddy],
  ]) {
    assert.doesNotMatch(
      config,
      /^\s*format json\s*$/m,
      `${name}: the plain json encoder logs request.uri with its query string`,
    );
    assert.match(config, /format filter \{/, `${name}: must use the filter log encoder`);
    assert.match(config, /wrap json/, `${name}: the filter must still wrap the json encoder`);
    assert.match(
      config,
      /request>uri query \{\s*\n\s*delete code\s*\n\s*delete state\s*\n\s*\}/,
      `${name}: the query filter must delete both code and state`,
    );
  }
});

// ---------------------------------------------------------------------------
// ...and neither may the ERROR log, which the site `log` directive above does
// NOT cover.
//
// A site-level `log` creates and filters only the ACCESS logger
// (`http.log.access.log0`), and that one name is all Caddy excludes from the
// default logger. `http.log.error.log0` therefore falls through to the default
// logger — no encoder, no filter, straight to stderr — and `docker logs`
// merges both streams. Reproduced against the pinned
// caddy:2-alpine@sha256:5f5c8640... (v2.11.4): before the `log default` block,
// a 502 on the callback printed `code` and `state` in full on stderr.
//
// It is the worse of the two leaks. The error logger fires when a handler
// FAILS — upstream unreachable, upstream timeout, client disconnect — so the
// authorization code was never delivered to the API: it is unspent, still live
// at Atlassian, and the `state` has its full ten minutes remaining.
//
// caddy/Caddyfile is included even though it declares no access log at all.
// That is exactly why it needs this: the error logger exists regardless, and
// that file leaked on a 502 with no `log` directive anywhere in it.
//
// This test exists because the block looks like duplication of the site `log`
// and reads like something to tidy away.
// ---------------------------------------------------------------------------
test('every Caddyfile filters the default logger, which is what carries the error log', () => {
  for (const [name, config] of [
    ['Caddyfile.bluegreen', caddy],
    ['Caddyfile.personal-server', personalServerCaddy],
    ['Caddyfile', productionCaddy],
  ]) {
    const globalBlock = /^\{\n([\s\S]*?)\n\}$/m.exec(config)?.[1];
    assert.ok(globalBlock, `${name}: no global options block to configure the default logger in`);

    const defaultLogger = /\n\tlog default \{\n([\s\S]*?)\n\t\}/.exec(globalBlock)?.[1];
    assert.ok(
      defaultLogger,
      `${name}: the global options block must carry a 'log default' block — without it Caddy's ` +
        'error logger writes the OAuth callback query string to stderr unfiltered',
    );

    assert.doesNotMatch(
      defaultLogger,
      /^\s*format json\s*$/m,
      `${name}: the plain json encoder logs request.uri with its query string`,
    );
    assert.match(defaultLogger, /format filter \{/, `${name}: the default logger must use the filter encoder`);
    assert.match(defaultLogger, /wrap json/, `${name}: the filter must still wrap the json encoder`);
    assert.match(
      defaultLogger,
      /request>uri query \{\s*\n\s*delete code\s*\n\s*delete state\s*\n\s*\}/,
      `${name}: the default logger's query filter must delete both code and state`,
    );
  }
});

test('active-upstreams.example.caddy is the tracked example of the generated live file', () => {
  assert.equal(
    activeUpstreamsExample,
    [
      '# Generated by scripts/bluegreen-deploy.mjs — do not edit by hand.',
      '# The engine writes the live colour\'s upstreams and gracefully reloads Caddy.',
      'reverse_proxy /api/* api-blue:3002',
      'reverse_proxy web-blue:3003',
      '',
    ].join('\n'),
  );
});

test('.gitignore excludes engine state and the generated live upstreams file, but not the example', () => {
  assert.match(gitignore, /^\.bluegreen\/$/m);
  assert.match(gitignore, /^caddy\/active-upstreams\.caddy$/m);
  assert.doesNotMatch(gitignore, /caddy\/active-upstreams\.example\.caddy/);
});

test('docker compose config renders a valid effective model for both colour profiles', () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'charitypilot-bluegreen-compose-'));
  const envFile = join(scratchDir, 'bluegreen.env');
  writeFileSync(
    envFile,
    [
      'POSTGRES_DB=charitypilot',
      'POSTGRES_USER=charitypilot',
      'POSTGRES_PASSWORD=scratch-password',
      'DATABASE_URL=postgresql://charitypilot:scratch-password@db:5432/charitypilot',
      'JWT_SECRET=scratch-jwt-secret-at-least-32-characters-long',
      'AUTH_RECOVERY_SECRET=scratch-recovery-secret-at-least-32-characters',
      'READINESS_API_KEY=scratch-readiness-key',
      'FRONTEND_URL=http://127.0.0.1:8080',
      'RESEND_API_KEY=scratch-resend-key',
      'EMAIL_FROM=notifications@example.org',
      'ERROR_ALERT_WEBHOOK_URL=http://127.0.0.1:9/alerts',
      'SUPABASE_URL=http://127.0.0.1:9/supabase',
      'SUPABASE_SERVICE_ROLE_KEY=scratch-supabase-key',
      'SUPABASE_STORAGE_BUCKET=scratch-bucket',
      'DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST=db',
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    BLUEGREEN_ENV_FILE: envFile,
    BLUEGREEN_BLUE_TAG: 'scratch-blue-commit',
    BLUEGREEN_GREEN_TAG: 'scratch-green-commit',
    BLUEGREEN_ACTIVE_TAG: 'scratch-blue-commit',
    BLUEGREEN_ORIGIN: 'http://127.0.0.1:8080',
    BLUEGREEN_FRONT_PORT: '8080',
  };

  const baseResult = spawnSync(
    'docker',
    ['compose', '-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen', 'config'],
    { cwd: repoRoot, encoding: 'utf8', env, timeout: DOCKER_COMPOSE_CONFIG_TIMEOUT_MS },
  );

  if (baseResult.error?.code === 'EPERM' || baseResult.error?.code === 'ENOENT') {
    // Docker is unavailable in this environment; the file's shape is already
    // pinned by every assertion above via plain-text parsing.
    return;
  }

  assert.equal(
    baseResult.status,
    0,
    baseResult.stderr || baseResult.error?.message || 'docker compose config failed',
  );
  // `env_file:` is flattened into `environment:` by `config`; assert the
  // scratch env file's values actually made it into a resolved service,
  // proving the env_file interpolation worked end to end.
  assert.match(baseResult.stdout, /POSTGRES_DB: charitypilot/);
  assert.match(baseResult.stdout, /image: charitypilot-bluegreen-migrations:scratch-blue-commit/);

  const blueResult = spawnSync(
    'docker',
    ['compose', '-f', 'compose.bluegreen.yml', '-p', 'charitypilot-bluegreen', '--profile', 'blue', 'config', '--services'],
    { cwd: repoRoot, encoding: 'utf8', env, timeout: DOCKER_COMPOSE_CONFIG_TIMEOUT_MS },
  );
  assert.equal(blueResult.status, 0, blueResult.stderr || 'docker compose config --profile blue failed');
  const blueServices = blueResult.stdout.trim().split('\n').sort();
  assert.deepEqual(blueServices, [
    'api-blue',
    'auth-recovery-secret-rotation',
    'caddy',
    'db',
    'deadline-reminders',
    'document-storage-cleanup',
    'migrate',
    'scheduler',
    'web-blue',
  ]);
  assert.ok(!blueServices.includes('api-green'));
  assert.ok(!blueServices.includes('web-green'));
});
