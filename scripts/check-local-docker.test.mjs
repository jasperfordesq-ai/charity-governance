import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const DOCKER_COMPOSE_CONFIG_TIMEOUT_MS = 120_000;

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function packageJson() {
  return JSON.parse(readRepoFile('package.json'));
}

test('base compose remains database-only for local development', () => {
  const compose = readRepoFile('compose.yml');

  assert.match(compose, /\nservices:\s*\n\s+db:/);
  assert.match(compose, /ports:[\s\S]*127\.0\.0\.1:5434:5432/);
  assert.doesNotMatch(compose, /\n\s+api:/);
  assert.doesNotMatch(compose, /\n\s+web:/);
});

test('local Docker overlay installs and runs API and web in development mode', () => {
  const localComposePath = join(repoRoot, 'compose.local.yml');
  assert.equal(existsSync(localComposePath), true, 'compose.local.yml must exist');

  const compose = readRepoFile('compose.local.yml');
  const apiPackage = JSON.parse(readRepoFile('apps/api/package.json'));

  assert.match(compose, /\nservices:\s*\n\s+deps:/);
  assert.match(compose, /\n\s+api:/);
  assert.match(compose, /\n\s+web:/);
  assert.match(compose, /deps:[\s\S]*environment:[\s\S]*NODE_ENV:\s+development/);
  assert.match(compose, /deps:[\s\S]*user:\s+\$\{CHARITYPILOT_LOCAL_CONTAINER_USER:-root\}/);
  assert.match(compose, /deps:[\s\S]*\.charitypilot-package-lock\.sha256/);
  assert.match(compose, /deps:[\s\S]*sha256sum package-lock\.json/);
  assert.match(compose, /deps:[\s\S]*Using existing node_modules volume/);
  assert.match(compose, /deps:[\s\S]*npm ci --include=dev/);
  assert.match(compose, /api:[\s\S]*user:\s+\$\{CHARITYPILOT_LOCAL_CONTAINER_USER:-root\}/);
  assert.match(compose, /web:[\s\S]*user:\s+\$\{CHARITYPILOT_LOCAL_CONTAINER_USER:-root\}/);
  assert.match(compose, /NODE_ENV:\s+development/);
  assert.match(compose, /web:[\s\S]*NODE_OPTIONS:\s+\$\{CHARITYPILOT_LOCAL_WEB_NODE_OPTIONS:---max-old-space-size=6144\}/);
  assert.match(compose, /DOCUMENT_STORAGE_DRIVER:\s+local/);
  assert.match(compose, /LOCAL_FILE_STORAGE_DIR:\s+\/app\/\.charitypilot-local-storage\/documents/);
  assert.match(compose, /SEED_LOCAL_ADMIN:\s+"true"/);
  assert.match(compose, /LOCAL_ADMIN_EMAIL:\s+admin@charitypilot\.local/);
  assert.match(compose, /LOCAL_ADMIN_PASSWORD:\s+LocalAdmin123!/);
  assert.match(compose, /DATABASE_URL:\s+postgresql:\/\/charitypilot:charitypilot_dev@db:5432\/charitypilot/);
  assert.match(compose, /FRONTEND_URL:\s+http:\/\/localhost:3003/);
  assert.match(compose, /NEXT_PUBLIC_API_URL:\s+http:\/\/localhost:3002/);
  assert.match(compose, /CHARITYPILOT_INTERNAL_API_URL:\s+http:\/\/api:3002/);
  assert.match(compose, /127\.0\.0\.1:3002:3002/);
  assert.match(compose, /127\.0\.0\.1:3003:3003/);
  assert.match(compose, /prisma migrate deploy --schema apps\/api\/prisma\/schema\.prisma/);
  assert.match(compose, /npm run db:seed -w @charitypilot\/api/);
  assert.match(compose, /npx --no-install tsx watch --clear-screen=false src\/server\.ts/);
  assert.match(compose, /web:[\s\S]*rm -rf apps\/web\/\.next\/\* && npm run dev -w @charitypilot\/web/);
  assert.match(compose, /NEXT_WEBPACK_USEPOLLING:\s+"1"/);
  assert.doesNotMatch(compose, /api:[\s\S]*node --import tsx --watch src\/server\.ts/);
  assert.doesNotMatch(compose, /tsx\/esm/);
  assert.equal(apiPackage.scripts.dev, 'node --env-file=.env --import tsx --watch src/server.ts');
  assert.match(compose, /\/api\/v1\/health/);
  assert.match(compose, /api:[\s\S]*deps:[\s\S]*condition:\s+service_completed_successfully/);
  assert.match(compose, /web:[\s\S]*deps:[\s\S]*condition:\s+service_completed_successfully/);
  assert.doesNotMatch(compose, /api:[\s\S]*command:[\s\S]*npm\s+(ci|install)/);
  assert.doesNotMatch(compose, /web:[\s\S]*command:[\s\S]*npm\s+(ci|install)/);
});

test('local development defaults use the documented API port', () => {
  const apiServer = readRepoFile('apps/api/src/server.ts');
  const webApiConfig = readRepoFile('apps/web/src/lib/api-config.ts');
  const rootEnvExample = readRepoFile('.env.example');

  assert.match(apiServer, /parsePort\(process\.env\.PORT,\s*3002\)/);
  assert.match(webApiConfig, /DEFAULT_DEVELOPMENT_API_URL\s*=\s*'http:\/\/localhost:3002'/);
  assert.match(rootEnvExample, /PORT=3002/);
});

test('local admin seed reports the configured admin account', () => {
  const seedScript = readRepoFile('apps/api/prisma/seed.ts');

  assert.match(seedScript, /return \{ email: config\.email, organisationName: organisation\.name \}/);
  assert.doesNotMatch(seedScript, /DEMO_EMAIL/);
  assert.doesNotMatch(seedScript, /DEMO_ORG_NAME/);
});

test('local admin seed sanitizes fatal errors before logging', () => {
  const seedScript = readRepoFile('apps/api/prisma/seed.ts');

  assert.match(seedScript, /import \{ serializeErrorForLog \} from '\.\.\/src\/utils\/logger\.js'/);
  assert.match(seedScript, /console\.error\('Prisma seed failed:',\s*serializeErrorForLog\(e\)\)/);
  assert.doesNotMatch(seedScript, /console\.error\(e\)/);
});

test('local admin seed stores starter documents in organisation-scoped local storage', () => {
  const seedScript = readRepoFile('apps/api/prisma/seed.ts');

  assert.doesNotMatch(seedScript, /fileUrl:\s*`\/demo\//);
  assert.match(seedScript, /\$\{organisationId\}\/seeded-documents\/\$\{slugifyDocumentName\(name\)\}\.pdf/);
  assert.match(seedScript, /DOCUMENT_STORAGE_DRIVER === 'local'/);
  assert.match(seedScript, /writeFile\(filePath, seededDocumentPdf\(documentName\)\)/);
});

test('web local env example matches the development CSP API origin', () => {
  const webEnvExample = readRepoFile('apps/web/.env.local.example');
  const contentSecurityPolicy = readRepoFile('apps/web/src/lib/content-security-policy.ts');
  const match = webEnvExample.match(/^NEXT_PUBLIC_API_URL=(.+)$/m);

  assert.ok(match, 'apps/web/.env.local.example must define NEXT_PUBLIC_API_URL');
  assert.match(contentSecurityPolicy, new RegExp(match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('local Docker overlay does not weaken production image gates', () => {
  const localCompose = readRepoFile('compose.local.yml');
  const apiDockerfile = readRepoFile('apps/api/Dockerfile');
  const webDockerfile = readRepoFile('apps/web/Dockerfile');

  assert.doesNotMatch(localCompose, /\n\s+build:/);
  assert.match(localCompose, /image:\s+\$\{CHARITYPILOT_LOCAL_NODE_IMAGE:-node:22-alpine\}/);
  assert.match(apiDockerfile, /ENV\s+NODE_ENV=production/);
  assert.match(apiDockerfile, /CMD\s+\["node",\s*"dist\/start\.js"\]/);
  assert.match(webDockerfile, /NEXT_PUBLIC_API_URL must be an origin-only CharityPilot production URL/);
  assert.match(webDockerfile, /CMD\s+\["node",\s*"server\.mjs"\]/);
});

test('local Docker compose overlay renders as a valid effective model with loopback-bound ports', () => {
  const result = spawnSync(
    'docker',
    ['compose', '-f', 'compose.yml', '-f', 'compose.local.yml', 'config'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      timeout: DOCKER_COMPOSE_CONFIG_TIMEOUT_MS,
    },
  );

  if (result.error?.code === 'EPERM') {
    const baseCompose = readRepoFile('compose.yml');
    const localCompose = readRepoFile('compose.local.yml');

    assert.match(baseCompose, /127\.0\.0\.1:5434:5432/);
    assert.match(localCompose, /127\.0\.0\.1:3002:3002/);
    assert.match(localCompose, /127\.0\.0\.1:3003:3003/);
    return;
  }

  assert.equal(
    result.status,
    0,
    result.stderr ||
      result.error?.message ||
      `docker compose config did not complete within ${DOCKER_COMPOSE_CONFIG_TIMEOUT_MS}ms`,
  );
  assert.match(result.stdout, /host_ip:\s+127\.0\.0\.1[\s\S]*target:\s+3002[\s\S]*published:\s+"3002"/);
  assert.match(result.stdout, /host_ip:\s+127\.0\.0\.1[\s\S]*target:\s+3003[\s\S]*published:\s+"3003"/);
  assert.match(result.stdout, /host_ip:\s+127\.0\.0\.1[\s\S]*target:\s+5432[\s\S]*published:\s+"5434"/);
});

test('local Docker smoke script boots the stack and checks API plus web over loopback', () => {
  const rootPackage = packageJson();
  const smokeScriptPath = join(repoRoot, 'scripts', 'smoke-local-docker.mjs');
  assert.equal(rootPackage.scripts['test:local-docker:smoke'], 'node scripts/smoke-local-docker.mjs');
  assert.equal(existsSync(smokeScriptPath), true, 'scripts/smoke-local-docker.mjs must exist');

  const smokeScript = readRepoFile('scripts/smoke-local-docker.mjs');
  assert.match(smokeScript, /compose\.yml/);
  assert.match(smokeScript, /compose\.local\.yml/);
  assert.match(smokeScript, /mkdirSync\(join\(repoRoot, 'apps', 'web', '\.next'\), \{ recursive: true \}\)/);
  assert.match(smokeScript, /const nextEnvPath = join\(repoRoot, 'apps', 'web', 'next-env\.d\.ts'\)/);
  assert.match(smokeScript, /const nextEnvSnapshot = existsSync\(nextEnvPath\) \? readFileSync\(nextEnvPath, 'utf8'\) : null/);
  assert.match(smokeScript, /writeFileSync\(nextEnvPath, nextEnvSnapshot\)/);
  assert.match(smokeScript, /'up', '--wait', '--wait-timeout', '180', '-d'/);
  assert.match(smokeScript, /http:\/\/127\.0\.0\.1:3002\/api\/v1\/health/);
  assert.match(smokeScript, /http:\/\/127\.0\.0\.1:3002\/api\/v1\/health\/readiness/);
  assert.match(smokeScript, /x-charitypilot-readiness-key/);
  assert.match(smokeScript, /local-readiness-key-at-least-32-characters/);
  assert.match(smokeScript, /http:\/\/127\.0\.0\.1:3002\/api\/v1\/auth\/register/);
  assert.match(smokeScript, /NewPassword1/);
  assert.match(smokeScript, /If this registration can be completed, check your email for next steps\./);
  assert.match(smokeScript, /admin@charitypilot\.local/);
  assert.match(smokeScript, /LocalAdmin123!/);
  assert.match(smokeScript, /http:\/\/127\.0\.0\.1:3002\/api\/v1\/auth\/login/);
  assert.match(smokeScript, /http:\/\/127\.0\.0\.1:3002\/api\/v1\/documents/);
  assert.match(smokeScript, /Seeded starter documents downloaded through local filesystem storage/);
  assert.match(smokeScript, /Document uploaded and downloaded through local filesystem storage/);
  assert.match(smokeScript, /set-cookie/i);
  assert.match(smokeScript, /await waitForCheck\('web root', smokeWeb, 300_000\)/);
  assert.match(smokeScript, /fetchWithTimeout\('http:\/\/127\.0\.0\.1:3003\/', \{\}, 60_000\)/);
  assert.match(smokeScript, /http:\/\/127\.0\.0\.1:3003\//);
  assert.match(smokeScript, /CharityPilot/);
  assert.doesNotMatch(smokeScript, /down', '-v'/);
});

test('local Docker migrations are a first-class command and are dry-runnable', () => {
  const rootPackage = packageJson();
  const migrationScriptPath = join(repoRoot, 'scripts', 'migrate-local-docker.mjs');

  assert.equal(rootPackage.scripts['db:migrate:local-docker'], 'node scripts/migrate-local-docker.mjs');
  assert.equal(existsSync(migrationScriptPath), true, 'scripts/migrate-local-docker.mjs must exist');

  const result = spawnSync('node', ['scripts/migrate-local-docker.mjs', '--dry-run'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /docker compose -f compose\.yml -f compose\.local\.yml up --wait --wait-timeout 180 -d db/);
  assert.match(result.stdout, /docker compose -f compose\.yml -f compose\.local\.yml run --rm --no-deps -T deps sh -lc/);
  assert.match(result.stdout, /lock_hash=\$\(sha256sum package-lock\.json \| awk '\{print \$1\}'\)/);
  assert.match(result.stdout, /marker=node_modules\/\.charitypilot-package-lock\.sha256/);
  assert.match(result.stdout, /cat .*marker/);
  assert.match(result.stdout, /= .*lock_hash/);
  assert.match(result.stdout, /npm ci --include=dev/);
  assert.match(result.stdout, /printf '%s\\n'.*lock_hash.*>.*marker/);
  assert.match(result.stdout, /npm run build -w @charitypilot\/shared && npm run db:generate -w @charitypilot\/api/);
  assert.match(result.stdout, /docker compose -f compose\.yml -f compose\.local\.yml run --rm --no-deps -T api npx prisma --config apps\/api\/prisma\.config\.ts migrate deploy --schema apps\/api\/prisma\/schema\.prisma/);
  assert.match(result.stdout, /docker compose -f compose\.yml -f compose\.local\.yml run --rm --no-deps -T api npx prisma --config apps\/api\/prisma\.config\.ts migrate status --schema apps\/api\/prisma\/schema\.prisma/);
});

test('dashboard accessibility scans allow protected route cold compiles to finish', () => {
  const accessibilitySpec = readRepoFile('e2e/tests/accessibility.spec.ts');
  const playwrightConfig = readRepoFile('e2e/playwright.config.ts');

  assert.match(
    accessibilitySpec,
    /const ACCESSIBILITY_TEST_TIMEOUT_MS = 300_000/,
  );
  assert.match(accessibilitySpec, /test\.describe\.configure\(\{\s*retries:\s*2,\s*timeout:\s*ACCESSIBILITY_TEST_TIMEOUT_MS\s*\}\)/);
  assert.match(playwrightConfig, /navigationTimeout:\s*150_000/);
});

test('e2e stack readiness fetches have bounded request lifetimes', () => {
  const globalSetup = readRepoFile('e2e/global-setup.ts');

  assert.match(globalSetup, /const STACK_READINESS_TIMEOUT_MS = 180_000/);
  assert.match(globalSetup, /const WEB_READINESS_TIMEOUT_MS = 600_000/);
  assert.match(globalSetup, /const ROUTE_WARM_TIMEOUT_MS = positiveIntEnv\('E2E_ROUTE_WARM_TIMEOUT_MS',\s*60_000\)/);
  assert.match(globalSetup, /const ROUTE_WARM_BUDGET_MS = positiveIntEnv\('E2E_ROUTE_WARM_BUDGET_MS',\s*240_000\)/);
  assert.match(globalSetup, /const SKIP_ROUTE_WARMING = process\.env\.E2E_SKIP_ROUTE_WARMING === 'true'/);
  assert.match(globalSetup, /function positiveIntEnv\(name: string,\s*fallback: number\): number/);
  assert.match(globalSetup, /Route warming skipped because E2E_SKIP_ROUTE_WARMING=true/);
  assert.match(globalSetup, /async function fetchWithTimeout\(url: string,\s*timeoutMs: number\): Promise<Response>/);
  assert.match(globalSetup, /const remainingMs = Math\.max\(1,\s*deadline - Date\.now\(\)\)/);
  assert.match(globalSetup, /await fetchWithTimeout\(url,\s*remainingMs\)/);
  assert.match(globalSetup, /const deadline = Date\.now\(\) \+ ROUTE_WARM_BUDGET_MS/);
  assert.match(globalSetup, /const timeoutMs = Math\.min\(ROUTE_WARM_TIMEOUT_MS,\s*remainingMs\)/);
  assert.match(globalSetup, /await fetchWithTimeout\(url,\s*timeoutMs\)/);
  assert.match(globalSetup, /waitForOk\(`\$\{WEB_BASE_URL\}\/`,\s*'Web app',\s*WEB_READINESS_TIMEOUT_MS\)/);
  assert.match(globalSetup, /finally\s*\{\s*clearTimeout\(timer\);\s*\}/);
  assert.doesNotMatch(globalSetup, /await fetch\(url,\s*\{\s*redirect:\s*'manual'\s*\}\)/);
});

test('e2e route warm-up precompiles public and auth smoke routes', () => {
  const globalSetup = readRepoFile('e2e/global-setup.ts');
  const requiredWarmRoutes = [
    '/',
    '/features',
    '/pricing',
    '/blog',
    '/blog/understanding-the-charities-governance-code',
    '/privacy',
    '/terms',
    '/login',
    '/register',
    '/forgot-password',
    '/reset-password',
    '/accept-invite',
    '/verify-email',
  ];

  assert.match(globalSetup, /const PUBLIC_ROUTES_TO_WARM = \[/);
  assert.match(globalSetup, /for \(const route of PUBLIC_ROUTES_TO_WARM\)/);

  for (const route of requiredWarmRoutes) {
    assert.match(
      globalSetup,
      new RegExp(`'${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
      `global setup must warm ${route}`,
    );
  }
});

test('accessibility scans navigate to rendered pages without waiting on dev-only load noise', () => {
  const accessibilitySpec = readRepoFile('e2e/tests/accessibility.spec.ts');

  assert.match(accessibilitySpec, /const NAVIGATION_TIMEOUT_MS = 300_000/);
  assert.match(accessibilitySpec, /resolveFirstComplianceDetailPath/);
  assert.doesNotMatch(accessibilitySpec, /helpers\/db/);
  assert.doesNotMatch(accessibilitySpec, /getPrincipleIdByNumber/);
  assert.match(accessibilitySpec, /async function waitForDocumentShell\(page: Page\): Promise<void>/);
  assert.match(accessibilitySpec, /async function applyTheme\(page: Page,\s*theme: Theme\): Promise<void>/);
  assert.match(accessibilitySpec, /Boolean\(document\.documentElement && document\.body\)/);
  assert.match(accessibilitySpec, /document\.documentElement\.classList\.toggle\('dark',\s*theme === 'dark'\)/);
  assert.match(accessibilitySpec, /gotoWithDevServerRetry\(ownerPage,\s*resolvedPath,\s*\{\s*waitUntil:\s*'commit',\s*timeout:\s*NAVIGATION_TIMEOUT_MS\s*\}\)/);
  assert.match(accessibilitySpec, /gotoWithDevServerRetry\(page,\s*path,\s*\{\s*waitUntil:\s*'commit',\s*timeout:\s*NAVIGATION_TIMEOUT_MS\s*\}\)/);
  assert.match(accessibilitySpec, /await applyTheme\(ownerPage,\s*'light'\)/);
  assert.match(accessibilitySpec, /await applyTheme\(ownerPage,\s*'dark'\)/);
  assert.match(accessibilitySpec, /for \(const theme of \['light', 'dark'\] as const\)/);
  assert.match(accessibilitySpec, /await applyTheme\(page,\s*theme\)/);
  assert.match(accessibilitySpec, /\$\{path\} \(\$\{theme\}\)/);
  assert.doesNotMatch(accessibilitySpec, /waitForLoadState\('networkidle'\)/);
  assert.doesNotMatch(accessibilitySpec, /waitUntil:\s*'domcontentloaded'/);
});

test('responsive smoke retries only local Next dev-server restart navigations', () => {
  const navigationHelper = readRepoFile('e2e/helpers/navigation.ts');
  const responsiveSpec = readRepoFile('e2e/tests/responsive-smoke.spec.ts');
  const fixtures = readRepoFile('e2e/fixtures.ts');

  assert.match(responsiveSpec, /resolveFirstComplianceDetailPath/);
  assert.doesNotMatch(responsiveSpec, /helpers\/db/);
  assert.doesNotMatch(responsiveSpec, /getPrincipleIdByNumber/);
  assert.match(responsiveSpec, /const FONT_SETTLE_TIMEOUT_MS = 5_000/);
  assert.match(responsiveSpec, /Promise\.race\(\[/);
  assert.match(responsiveSpec, /setTimeout\(resolve,\s*timeoutMs\)/);
  assert.match(responsiveSpec, /\},\s*FONT_SETTLE_TIMEOUT_MS\)/);
  assert.match(responsiveSpec, /localStorage\.setItem\('cookie-consent', 'declined'\)/);
  assert.match(responsiveSpec, /await suppressCookieConsent\(page\)/);
  assert.match(navigationHelper, /DEV_SERVER_RESTART_ERROR_PATTERNS = \[/);
  assert.match(navigationHelper, /net::ERR_EMPTY_RESPONSE/);
  assert.match(navigationHelper, /net::ERR_CONNECTION_RESET/);
  assert.match(navigationHelper, /net::ERR_CONNECTION_REFUSED/);
  assert.match(navigationHelper, /net::ERR_SOCKET_NOT_CONNECTED/);
  assert.match(navigationHelper, /net::ERR_ABORTED; maybe frame was detached/);
  assert.match(navigationHelper, /page\.goto: Timeout/);
  assert.match(navigationHelper, /if \(IS_DEPLOYED_QA \|\| !isDevServerRestartNavigationError\(err\) \|\| attempt === 2\)/);
  assert.match(navigationHelper, /await waitForLocalWebServer\(\)/);
  assert.match(navigationHelper, /return await page\.goto\(url,\s*gotoOptions\)/);
  assert.match(navigationHelper, /export async function resolveFirstComplianceDetailPath\(page: Page,\s*options\?: GotoOptions\): Promise<string>/);
  assert.match(navigationHelper, /locator\('a\[href\^="\/compliance\/"\]'\)/);
  assert.match(responsiveSpec, /import \{ gotoWithDevServerRetry, resolveFirstComplianceDetailPath \} from '\.\.\/helpers\/navigation'/);
  assert.match(fixtures, /import \{ gotoWithDevServerRetry \} from '\.\/helpers\/navigation'/);
  assert.doesNotMatch(responsiveSpec, /document\.fonts\.ready\.then\(\(\) => undefined\)\)/);
  assert.doesNotMatch(responsiveSpec, /(?:page|ownerPage)\.goto\(.*waitUntil:\s*'commit'/);
  assert.doesNotMatch(fixtures, /await page\.goto\('\/(?:register|login)'/);
});

test('web dev server ignores Playwright artifacts during local browser QA', () => {
  const nextConfig = readRepoFile('apps/web/next.config.ts');
  const playwrightConfig = readRepoFile('e2e/playwright.config.ts');
  const e2eReadme = readRepoFile('e2e/README.md');
  const e2eWorkflow = readRepoFile('.github/workflows/e2e.yml');

  assert.match(nextConfig, /webpack\(config,\s*\{\s*dev\s*\}\)/);
  assert.match(nextConfig, /if \(dev\)/);
  assert.match(nextConfig, /\*\*\/e2e\/test-results\/\*\*/);
  assert.match(nextConfig, /\*\*\/e2e\/playwright-report\/\*\*/);
  assert.match(nextConfig, /\*\*\/apps\/web\/\.next\/\*\*/);
  assert.match(nextConfig, /\*\*\/apps\/web\/\.next-dev\/\*\*/);
  assert.match(nextConfig, /\*\*\/apps\/web\/\.next-build-\*\/\*\*/);
  assert.match(nextConfig, /\*\*\/apps\/web\/\.test-dist\/\*\*/);
  assert.match(nextConfig, /\*\*\/apps\/web\/\.turbo\/\*\*/);
  assert.match(nextConfig, /\*\*\/apps\/web\/next-codex-build\/\*\*/);
  assert.match(playwrightConfig, /process\.env\.E2E_ARTIFACT_DIR \?\? join\(tmpdir\(\), 'charitypilot-e2e-artifacts'\)/);
  assert.match(playwrightConfig, /outputDir:\s*join\(ARTIFACT_ROOT, 'test-results'\)/);
  assert.match(playwrightConfig, /outputFolder:\s*join\(ARTIFACT_ROOT, 'html-report'\)/);
  assert.match(playwrightConfig, /mkdirSync\(join\(ARTIFACT_ROOT, 'test-results'\), \{ recursive: true \}\)/);
  assert.match(playwrightConfig, /mkdirSync\(join\(ARTIFACT_ROOT, 'html-report'\), \{ recursive: true \}\)/);
  assert.match(e2eReadme, /written outside the repository so Next\.js dev does not watch the artifacts/);
  assert.match(e2eWorkflow, /E2E_ARTIFACT_DIR:\s*playwright-artifacts/);
  assert.match(e2eWorkflow, /path:\s*e2e\/playwright-artifacts\/html-report\//);
});

test('e2e authenticated owner setup has cold compile headroom', () => {
  const fixtures = readRepoFile('e2e/fixtures.ts');

  assert.match(fixtures, /await gotoWithDevServerRetry\(page,\s*'\/login',\s*\{\s*waitUntil:\s*'domcontentloaded'\s*\}\)/);
  assert.match(fixtures, /const POST_LOGIN_DASHBOARD_TIMEOUT_MS = IS_DEPLOYED_QA \? 60_000 : 180_000/);
  assert.match(fixtures, /const \{ userId, organisationId \} = await createVerifiedOwner/);
  assert.match(fixtures, /if \(IS_DEPLOYED_QA\) \{[\s\S]*await loginViaUi\(page,\s*existingOwner\.email,\s*existingOwner\.password\)/);
  assert.match(
    fixtures,
    /const storageState = await createAuthenticatedStorageState\(\{\s*userId,\s*organisationId,\s*role:\s*'OWNER',\s*\}\)/,
  );
  assert.doesNotMatch(fixtures, /await loginViaUi\(page,\s*email,\s*password\)/);
  assert.doesNotMatch(fixtures, /await registerViaUi\(page,\s*\{\s*email,\s*name:\s*'Shared Owner'/);
  assert.doesNotMatch(fixtures, /await markEmailVerified/);
  assert.match(fixtures, /waitForResponse\(/);
  assert.match(fixtures, /api\\\/v1\\\/auth\\\/login/);
  assert.match(fixtures, /formPath: string/);
  assert.match(fixtures, /await gotoWithDevServerRetry\(page,\s*formPath,\s*\{\s*waitUntil:\s*'domcontentloaded'\s*\}\)/);
  assert.match(fixtures, /page\.waitForURL\(expectedUrl,\s*\{\s*timeout:\s*60_000\s*\}\)/);
  assert.match(fixtures, /expect\(page\)\.toHaveURL\(expectedUrl,\s*\{\s*timeout:\s*60_000\s*\}\)/);
  assert.match(fixtures, /page\.getByRole\('heading', \{ name: \/Welcome back\/ \}\)/);
  assert.match(fixtures, /toBeVisible\(\{\s*timeout:\s*POST_LOGIN_DASHBOARD_TIMEOUT_MS,\s*\}\)/);
  assert.doesNotMatch(
    fixtures,
    /expect\(page\.getByRole\('heading', \{ name: \/Welcome back\/ \}\)\)\.toBeVisible\(\);/,
  );
  assert.match(fixtures, /const AUTHENTICATED_OWNER_SETUP_TIMEOUT_MS = 900_000/);
  assert.match(fixtures, /\{\s*scope:\s*'worker',\s*timeout:\s*AUTHENTICATED_OWNER_SETUP_TIMEOUT_MS\s*\}/);
});

test('local owner pages receive a fresh local auth session for long full-suite runs', () => {
  const fixtures = readRepoFile('e2e/fixtures.ts');
  const db = readRepoFile('e2e/helpers/db.ts');

  assert.match(db, /export async function createAuthenticatedStorageState/);
  assert.match(db, /INSERT INTO "AuthSession" \("id", "userId", "refreshTokenHash", "expiresAt", "updatedAt"\)/);
  assert.match(db, /signLocalAccessToken/);
  assert.match(db, /local-dev-jwt-secret-at-least-32-characters/);
  assert.match(db, /charitypilot_access/);
  assert.match(db, /charitypilot_refresh/);
  assert.match(db, /localStorage:\s*\[\{\s*name:\s*'cookie-consent',\s*value:\s*'declined'\s*\}\]/);
  assert.match(fixtures, /createAuthenticatedStorageState/);
  assert.match(fixtures, /IS_DEPLOYED_QA\s*\?\s*owner\.storageState\s*:\s*await createAuthenticatedStorageState/);
});

test('local direct owner setup mirrors registration without using deployed QA seams', () => {
  const db = readRepoFile('e2e/helpers/db.ts');

  assert.match(db, /import bcrypt from 'bcryptjs'/);
  assert.match(db, /export async function createVerifiedOwner/);
  assert.match(db, /assertLocalDatabaseSeamAllowed\(\);/);
  assert.match(db, /bcrypt\.hash\(data\.password,\s*12\)/);
  assert.match(db, /INSERT INTO "Organisation" \("id", "name", "updatedAt"\)/);
  assert.match(db, /INSERT INTO "User" \("id", "email", "name", "passwordHash", "role", "organisationId", "emailVerified", "updatedAt"\)/);
  assert.match(db, /VALUES \(\$1, \$2, \$3, \$4, 'OWNER', \$5, true, \$6\)/);
  assert.match(db, /INSERT INTO "Subscription" \("id", "organisationId", "plan", "status", "trialEndsAt", "updatedAt"\)/);
  assert.match(db, /VALUES \(\$1, \$2, 'ESSENTIALS', 'TRIALING', \$3, \$4\)/);
  assert.match(db, /await client\.query\('ROLLBACK'\)/);
});

test('auth journey helpers still exercise registration UI directly', () => {
  const fixtures = readRepoFile('e2e/fixtures.ts');

  assert.match(fixtures, /export async function registerViaUi/);
  assert.match(fixtures, /async function suppressCookieConsent\(page: Page\): Promise<void>/);
  assert.match(fixtures, /localStorage\.setItem\('cookie-consent', 'declined'\)/);
  assert.match(fixtures, /await gotoWithDevServerRetry\(page,\s*'\/register',\s*\{\s*waitUntil:\s*'domcontentloaded'\s*\}\)/);
  assert.match(fixtures, /await gotoWithDevServerRetry\(page,\s*'\/login',\s*\{\s*waitUntil:\s*'domcontentloaded'\s*\}\)/);
});

test('deployed browser QA mode does not reset or mutate databases through local seams', () => {
  const env = readRepoFile('e2e/env.ts');
  const db = readRepoFile('e2e/helpers/db.ts');
  const globalSetup = readRepoFile('e2e/global-setup.ts');
  const fixtures = readRepoFile('e2e/fixtures.ts');
  const e2eReadme = readRepoFile('e2e/README.md');
  const browserQa = readRepoFile('docs/production-browser-qa.md');

  assert.match(env, /E2E_DEPLOYED_QA/);
  assert.match(env, /E2E_OWNER_EMAIL/);
  assert.match(env, /E2E_OWNER_PASSWORD/);
  assert.match(env, /deployedQaOwnerCredentials/);
  assert.match(env, /requires E2E_OWNER_EMAIL and E2E_OWNER_PASSWORD/);

  assert.match(db, /assertLocalDatabaseSeamAllowed/);
  assert.match(db, /E2E_DEPLOYED_QA=true forbids direct database access/);
  assert.match(db, /assertLocalDatabaseSeamAllowed\(\);\s*const client = new Client/);

  assert.match(globalSetup, /IS_DEPLOYED_QA/);
  assert.match(globalSetup, /if \(IS_DEPLOYED_QA\) \{[\s\S]*database reset and route warming skipped/);
  assert.match(globalSetup, /await resetDb\(\);/);
  assert.match(globalSetup, /await warmRoutes\(\);/);

  assert.match(fixtures, /IS_DEPLOYED_QA/);
  assert.match(fixtures, /deployedQaOwnerCredentials/);
  assert.match(fixtures, /if \(IS_DEPLOYED_QA\) \{[\s\S]*await loginViaUi\(page, existingOwner\.email, existingOwner\.password\)/);
  assert.match(fixtures, /userId:\s*'deployed-qa-existing-user'/);
  assert.match(fixtures, /organisationId:\s*'deployed-qa-existing-organisation'/);

  assert.match(e2eReadme, /Deployed browser QA mode/);
  assert.match(e2eReadme, /E2E_DEPLOYED_QA=true/);
  assert.match(e2eReadme, /does not reset the database/);
  assert.match(browserQa, /E2E_DEPLOYED_QA=true/);
  assert.match(browserQa, /E2E_OWNER_EMAIL/);
  assert.match(browserQa, /E2E_OWNER_PASSWORD/);
  assert.match(browserQa, /approved non-sensitive test workspace/);
});

test('platform audit ledger records deployed browser QA hardening', () => {
  const auditGenerator = readRepoFile('scripts/platform-completion-audit.mjs');
  const auditLedger = readRepoFile('docs/platform-completion-audit.md');

  assert.match(auditGenerator, /Deployed browser QA mode now uses existing non-sensitive test credentials/);
  assert.match(auditGenerator, /direct database reset or token-injection seams/);
  assert.match(auditLedger, /Deployed browser QA mode now uses existing non-sensitive test credentials/);
  assert.match(auditLedger, /direct database reset or token-injection seams/);
});

test('platform audit ledger records local browser evidence without closing deployed gates', () => {
  const auditGenerator = readRepoFile('scripts/platform-completion-audit.mjs');
  const auditLedger = readRepoFile('docs/platform-completion-audit.md');
  const auditBaseCommit = auditLedger.match(/Working-tree base commit when generated: `([a-f0-9]+)`/)?.[1];

  assert.match(auditGenerator, /Local Verification Evidence/);
  assert.match(auditGenerator, /npm run release:ready -- --no-e2e/);
  assert.match(auditGenerator, /RECORDED_SELECTED_GATE_EVIDENCE/);
  assert.doesNotMatch(auditGenerator, /passed locally on 2026-07-08 at commit \$\{commit\}/);
  assert.match(auditGenerator, /npm run test:e2e:responsive/);
  assert.match(auditGenerator, /E2E_DEPLOYED_QA=true/);
  assert.match(auditLedger, /Local Verification Evidence/);
  assert.ok(auditBaseCommit, 'audit ledger must record the generated base commit');
  assert.match(auditLedger, /passed locally on 2026-07-08 at commit [a-f0-9]{7,40}/);
  assert.doesNotMatch(auditLedger, /passed locally on 2026-07-08 at commit 73e8484/);
  assert.match(auditLedger, /9\/85 evidence checks/);
  assert.doesNotMatch(auditLedger, /0\/85 evidence checks/);
  assert.match(auditLedger, /304\/304 production-tooling checks/);
  assert.doesNotMatch(auditLedger, /300\/300 production-tooling checks/);
  assert.doesNotMatch(auditLedger, /298\/298 production-tooling checks/);
  assert.doesNotMatch(auditLedger, /297\/297 production-tooling checks/);
  assert.doesNotMatch(auditLedger, /286\/286 production-tooling checks/);
  assert.match(auditLedger, /security scan, lint, build, workspace tests, dependency audit, and reliability ledger passed/);
  assert.match(auditLedger, /only Playwright E2E was skipped/);
  assert.match(auditLedger, /Local responsive browser QA completed cleanly on 2026-07-08/);
  assert.match(auditLedger, /public desktop 13\/13/);
  assert.match(auditLedger, /dashboard desktop 12\/12/);
  assert.match(auditLedger, /dashboard mobile 12\/12/);
  assert.match(auditLedger, /public\/auth and dashboard routes[\s\S]*light and dark themes/);
  assert.match(auditLedger, /deployed HTTPS QA/);
});

test('platform audit ledger records launch evidence gate hardening', () => {
  const auditGenerator = readRepoFile('scripts/platform-completion-audit.mjs');
  const auditLedger = readRepoFile('docs/platform-completion-audit.md');

  assert.match(auditGenerator, /Launch status now separates missing production env values from external launch evidence gates/);
  assert.match(auditGenerator, /85 machine-readable launch evidence checks/);
  assert.match(auditGenerator, /launch evidence ledger status/);
  assert.match(auditGenerator, /launch evidence approval state, final signoff state, and the next incomplete checks/);
  assert.match(auditGenerator, /Release binding/);
  assert.match(auditGenerator, /releaseBinding\.headline/);
  assert.match(auditGenerator, /final approval role progress separately from checklist completion/);
  assert.match(auditGenerator, /group missing production values by provider\/source/);
  assert.match(auditGenerator, /approvedForLaunch/);
  assert.match(auditGenerator, /finalSignoff/);
  assert.match(auditGenerator, /Final approval roles approved/);
  assert.match(auditGenerator, /Strict launch gates/);
  assert.match(auditGenerator, /percentages\.strictLaunchGates/);
  assert.match(auditGenerator, /Next incomplete checks/);
  assert.match(auditGenerator, /browserQa accessibility, cross-browser, and iOS Safari evidence slots/);
  assert.match(auditGenerator, /releaseImagePromotion/);
  assert.match(auditGenerator, /Release Image Promotion/);
  assert.match(auditGenerator, /release image promotion GitHub environment variables/);
  assert.match(auditGenerator, /legal\/compliance final approval/);
  assert.match(auditLedger, /Launch status now separates missing production env values from external launch evidence gates/);
  assert.match(auditLedger, /85 machine-readable launch evidence checks/);
  assert.match(auditLedger, /launch evidence ledger status/);
  assert.match(auditLedger, /launch evidence approval state, final signoff state, and the next incomplete checks/);
  assert.match(auditLedger, /Release binding:/);
  assert.match(auditLedger, /Launch Progress Summary/);
  assert.match(auditLedger, /Strict launch gates complete: 18 \/ 118 \(100 remaining, 15\.3% complete\)/);
  assert.match(auditLedger, /final approval role progress separately from checklist completion/);
  assert.match(auditLedger, /group missing production values by provider\/source/);
  assert.match(auditLedger, /Local-state note/);
  assert.match(auditLedger, /Local Production Environment State/);
  assert.match(auditLedger, /Release Image Promotion/);
  assert.match(auditLedger, /Protected Final Launch Evidence Workflow/);
  assert.match(auditLedger, /\.github\/workflows\/production-launch-evidence\.yml/);
  assert.match(auditLedger, /gh workflow run production-launch-evidence\.yml --ref master/);
  assert.match(auditLedger, /GitHub environment: `production`/);
  assert.match(auditLedger, /NEXT_PUBLIC_API_URL=https:\/\/api\.charitypilot\.ie/);
  assert.match(auditLedger, /NEXT_PUBLIC_SUPABASE_URL=https:\/\/YOUR_SUPABASE_PROJECT_REF\.supabase\.co/);
  assert.match(auditLedger, /gh workflow run release-images\.yml --ref master/);
  assert.match(auditLedger, /release-image-digests\.env/);
  assert.match(auditLedger, /CHARITYPILOT_\*_IMAGE/);
  assert.match(auditLedger, /non-committed/);
  assert.ok(
    /approvedForLaunch: false/.test(auditLedger) || /production-launch-evidence\.json has not been created yet/.test(auditLedger),
    'audit ledger should report either local launch-evidence progress or missing local launch evidence',
  );
  assert.ok(
    /Grouped by source/.test(auditLedger) || /Phase: `NO_ENV`/.test(auditLedger),
    'audit ledger should report either local placeholder groups or the fresh-clone NO_ENV state',
  );
  assert.match(auditLedger, /browserQa accessibility, cross-browser, and iOS Safari evidence slots/);
  assert.match(auditLedger, /legal\/compliance final approval/);
});

test('product revamp page inventory is not stale pre-revamp guidance', () => {
  const pageInventory = readRepoFile('docs/product-revamp/page-inventory.md');

  assert.match(pageInventory, /Superseded by the generated platform completion audit/);
  assert.match(pageInventory, /docs\/platform-completion-audit\.md/);
  assert.match(pageInventory, /25 page routes scanned/);
  assert.match(pageInventory, /0 route files are 450\+ lines/);
  assert.match(pageInventory, /Deployed browser QA remains the proof gate/);
  assert.doesNotMatch(pageInventory, /manual inline SVG/i);
  assert.doesNotMatch(pageInventory, /light-only/i);
  assert.doesNotMatch(pageInventory, /largest route.*804/i);
  assert.doesNotMatch(pageInventory, /dark mode: missing/i);
});

test('responsive route smoke is runnable as a focused launch QA command', () => {
  const rootPackage = packageJson();
  const responsiveSpecPath = join(repoRoot, 'e2e', 'tests', 'responsive-smoke.spec.ts');
  assert.equal(rootPackage.scripts['test:e2e:responsive'], 'cd e2e && npm test -- tests/responsive-smoke.spec.ts');
  assert.equal(
    rootPackage.scripts['test:e2e:responsive:public:desktop'],
    'cd e2e && npm test -- tests/responsive-smoke.spec.ts --grep "launch-critical public/auth route .* renders in desktop light and dark"',
  );
  assert.equal(
    rootPackage.scripts['test:e2e:responsive:public:mobile'],
    'cd e2e && npm test -- tests/responsive-smoke.spec.ts --grep "launch-critical public/auth route .* renders in mobile light and dark"',
  );
  assert.equal(
    rootPackage.scripts['test:e2e:responsive:dashboard:desktop'],
    'cd e2e && npm test -- tests/responsive-smoke.spec.ts --grep "launch-critical dashboard route .* renders in desktop light and dark"',
  );
  assert.equal(
    rootPackage.scripts['test:e2e:responsive:dashboard:mobile'],
    'cd e2e && npm test -- tests/responsive-smoke.spec.ts --grep "launch-critical dashboard route .* renders in mobile light and dark"',
  );
  assert.equal(existsSync(responsiveSpecPath), true, 'responsive-smoke.spec.ts must exist');

  const responsiveSpec = readRepoFile('e2e/tests/responsive-smoke.spec.ts');
  const browserQa = readRepoFile('docs/production-browser-qa.md');
  const e2eReadme = readRepoFile('e2e/README.md');
  assert.match(responsiveSpec, /mobile light and dark/);
  assert.match(responsiveSpec, /desktop light and dark/);
  assert.match(responsiveSpec, /horizontal page overflow/);
  assert.match(responsiveSpec, /launch-critical public\/auth route/);
  assert.match(responsiveSpec, /launch-critical dashboard route/);
  assert.match(responsiveSpec, /const NAVIGATION_TIMEOUT_MS = 300_000/);
  assert.match(responsiveSpec, /const PUBLIC_ROUTE_TIMEOUT_MS = 420_000/);
  assert.match(responsiveSpec, /const DASHBOARD_ROUTE_TIMEOUT_MS = 420_000/);
  assert.match(responsiveSpec, /test\.setTimeout\(PUBLIC_ROUTE_TIMEOUT_MS\)/);
  assert.match(responsiveSpec, /test\.setTimeout\(DASHBOARD_ROUTE_TIMEOUT_MS\)/);
  assert.match(responsiveSpec, /async function waitForDocumentShell\(page: Page\): Promise<void>/);
  assert.match(responsiveSpec, /Boolean\(document\.documentElement && document\.body\)/);
  assert.match(responsiveSpec, /await waitForDocumentShell\(page\);[\s\S]*await applyTheme\(page, theme\);/);
  assert.match(responsiveSpec, /await waitForDocumentShell\(ownerPage\);[\s\S]*await applyTheme\(ownerPage, theme\);/);
  assert.match(responsiveSpec, /gotoWithDevServerRetry\(page,\s*route,\s*\{\s*waitUntil:\s*'commit',\s*timeout:\s*NAVIGATION_TIMEOUT_MS\s*\}\)/);
  assert.match(responsiveSpec, /launch-critical dashboard route \$\{typeof route === 'string' \? route : route\.label\} renders/);
  assert.match(responsiveSpec, /for \(const route of DASHBOARD_ROUTES\)[\s\S]*gotoWithDevServerRetry\(ownerPage,\s*path,\s*\{\s*waitUntil:\s*'commit',\s*timeout:\s*NAVIGATION_TIMEOUT_MS\s*\}\)/);
  assert.match(responsiveSpec, /waitUntil:\s*'commit'/);
  assert.doesNotMatch(responsiveSpec, /waitUntil:\s*'domcontentloaded'/);
  assert.doesNotMatch(responsiveSpec, /launch-critical public and auth routes render/);
  assert.doesNotMatch(responsiveSpec, /launch-critical dashboard routes render/);
  assert.doesNotMatch(responsiveSpec, /launch-critical dashboard route \$\{testLabel\}/);
  assert.doesNotMatch(responsiveSpec, /waitForLoadState\('networkidle'\)/);
  assert.match(browserQa, /all four focused route chunks/);
  assert.match(browserQa, /test:e2e:responsive:public:desktop/);
  assert.match(browserQa, /test:e2e:responsive:public:mobile/);
  assert.match(browserQa, /test:e2e:responsive:dashboard:desktop/);
  assert.match(browserQa, /test:e2e:responsive:dashboard:mobile/);
  assert.match(e2eReadme, /full 50-test matrix/);
  assert.match(e2eReadme, /E2E_DEPLOYED_QA=true[\s\S]*npm run test:e2e:responsive:public:desktop/);
  assert.match(e2eReadme, /E2E_DEPLOYED_QA=true[\s\S]*npm run test:e2e:deployed:responsive:cross-browser/);
  assert.match(e2eReadme, /SECRET_STORE_E2E_OWNER_EMAIL/);
  assert.match(e2eReadme, /SECRET_STORE_E2E_OWNER_PASSWORD/);
  assert.doesNotMatch(e2eReadme, /qa-owner@example\.com|from-secret-store/);
  assert.match(e2eReadme, /test:e2e:responsive:public:desktop/);
  assert.match(e2eReadme, /test:e2e:responsive:dashboard:mobile/);
  assert.match(e2eReadme, /Invalid file descriptor to ICU data/);
  assert.match(e2eReadme, /npm --prefix e2e exec playwright -- install chromium/);
  assert.match(e2eReadme, /icudtl\.dat/);
});

test('responsive route smoke covers every shipped page route', () => {
  const responsiveSpec = readRepoFile('e2e/tests/responsive-smoke.spec.ts');
  const requiredRoutes = [
    '/',
    '/features',
    '/pricing',
    '/blog',
    '/blog/understanding-the-charities-governance-code',
    '/privacy',
    '/terms',
    '/login',
    '/register',
    '/forgot-password',
    '/reset-password',
    '/accept-invite',
    '/verify-email',
    '/dashboard',
    '/compliance',
    '/compliance/${principleId}',
    '/board',
    '/documents',
    '/deadlines',
    '/registers',
    '/regulator',
    '/organisation',
    '/team',
    '/billing',
    '/export',
  ];

  for (const route of requiredRoutes) {
    assert.match(
      responsiveSpec,
      new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `responsive smoke must cover ${route}`,
    );
  }
});

test('deployed browser QA matrix is runnable as focused launch evidence commands', () => {
  const rootPackage = packageJson();
  const e2ePackageJson = JSON.parse(readRepoFile('e2e/package.json'));
  const playwrightConfig = readRepoFile('e2e/playwright.config.ts');
  const browserQa = readRepoFile('docs/production-browser-qa.md');
  const e2eReadme = readRepoFile('e2e/README.md');

  assert.equal(
    rootPackage.scripts['test:e2e:deployed:responsive:cross-browser'],
    'cd e2e && npm run test:deployed:responsive:cross-browser',
  );
  assert.equal(
    rootPackage.scripts['test:e2e:deployed:accessibility:cross-browser'],
    'cd e2e && npm run test:deployed:accessibility:cross-browser',
  );
  assert.equal(
    e2ePackageJson.scripts['test:deployed:responsive:cross-browser'],
    'playwright test tests/responsive-smoke.spec.ts --project=deployed-chromium-desktop --project=deployed-chromium-mobile --project=deployed-firefox-desktop --project=deployed-webkit-desktop',
  );
  assert.equal(
    e2ePackageJson.scripts['test:deployed:accessibility:cross-browser'],
    'playwright test tests/accessibility.spec.ts --project=deployed-chromium-desktop --project=deployed-chromium-mobile --project=deployed-firefox-desktop --project=deployed-webkit-desktop',
  );
  assert.match(e2ePackageJson.scripts['install:browsers'], /chromium firefox webkit/);
  assert.match(playwrightConfig, /deployed-chromium-desktop/);
  assert.match(playwrightConfig, /deployed-chromium-mobile/);
  assert.match(playwrightConfig, /deployed-firefox-desktop/);
  assert.match(playwrightConfig, /deployed-webkit-desktop/);
  assert.match(playwrightConfig, /E2E_DEPLOYED_QA/);
  assert.match(browserQa, /test:e2e:deployed:responsive:cross-browser/);
  assert.match(browserQa, /test:e2e:deployed:accessibility:cross-browser/);
  assert.match(e2eReadme, /test:e2e:deployed:responsive:cross-browser/);
  assert.match(e2eReadme, /Desktop Firefox/);
  assert.match(e2eReadme, /Desktop WebKit/);
});

test('local Docker migrations stop running app services before refreshing dependencies', () => {
  const migrationScript = readRepoFile('scripts/migrate-local-docker.mjs');

  assert.match(migrationScript, /const localAppServicesRunningBeforeMigration = runningLocalAppServices\(context\)/);
  assert.match(migrationScript, /stopLocalAppServices\(localAppServicesRunningBeforeMigration, context\)/);
  assert.match(migrationScript, /startLocalAppServices\(localAppServicesRunningBeforeMigration, context\)/);
  assert.ok(
    migrationScript.indexOf('const localAppServicesRunningBeforeMigration = runningLocalAppServices(context)') <
      migrationScript.indexOf('stopLocalAppServices(localAppServicesRunningBeforeMigration, context)'),
    'local app services must be recorded before they are stopped',
  );
  assert.ok(
    migrationScript.indexOf('stopLocalAppServices(localAppServicesRunningBeforeMigration, context)') <
      migrationScript.indexOf('for (const command of commands)'),
    'local app services must be recorded before the dependency refresh can disrupt watchers',
  );
  assert.ok(
    migrationScript.indexOf('startLocalAppServices(localAppServicesRunningBeforeMigration, context)') >
      migrationScript.indexOf('for (const command of commands)'),
    'running local app services must be started after migrations and dependency refresh complete',
  );
  assert.match(migrationScript, /'stop',\s*\.\.\.services/);
  assert.match(migrationScript, /'up', '--wait', '--wait-timeout', '180', '-d', \.\.\.services/);
});

test('local Docker migrations restart previously running app services when migration fails', async () => {
  const originalArgv = process.argv;
  let module;
  try {
    process.argv = ['node', 'scripts/migrate-local-docker.mjs', '--dry-run'];
    module = await import(`${pathToFileURL(join(repoRoot, 'scripts', 'migrate-local-docker.mjs')).href}?restart-failure-test`);
  } finally {
    process.argv = originalArgv;
  }
  const calls = [];
  const spawnSyncImpl = (executable, args) => {
    const command = [executable, ...args];
    calls.push(command.join(' '));
    if (args.includes('ps') && args.includes('--format') && args.includes('json')) {
      return {
        status: 0,
        stdout: [
          JSON.stringify({ Service: 'api', State: 'running' }),
          JSON.stringify({ Service: 'web', State: 'running' }),
          '',
        ].join('\n'),
        stderr: '',
      };
    }
    if (args.includes('migrate') && args.includes('deploy')) {
      return { status: 23, stdout: '', stderr: 'simulated migrate deploy failure\n' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.equal(typeof module.runLocalDockerMigrations, 'function');
  assert.throws(
    () => module.runLocalDockerMigrations({
      args: [],
      processEnv: {},
      spawnSyncImpl,
      writeOutput: () => {},
    }),
    /migrate deploy.*failed with exit code 23/s,
  );

  const stopIndex = calls.indexOf('docker compose -f compose.yml -f compose.local.yml stop api web');
  const failedMigrationIndex = calls.findIndex((call) => call.includes('migrate deploy'));
  const restartIndex = calls.indexOf('docker compose -f compose.yml -f compose.local.yml up --wait --wait-timeout 180 -d api web');

  assert.notEqual(stopIndex, -1, 'migration runner must stop previously running app services');
  assert.notEqual(failedMigrationIndex, -1, 'test must simulate a migration failure');
  assert.notEqual(restartIndex, -1, 'migration runner must restart previously running app services after failure');
  assert.ok(stopIndex < failedMigrationIndex, 'services must stop before the failing migration');
  assert.ok(failedMigrationIndex < restartIndex, 'services must restart after the failing migration');
});

test('local Docker smoke reapplies migrations even when services are already running', () => {
  const smokeScript = readRepoFile('scripts/smoke-local-docker.mjs');

  assert.match(smokeScript, /migrate-local-docker\.mjs/);
  assert.match(smokeScript, /await runLocalDockerMigrations\(\)/);
  assert.ok(
    smokeScript.indexOf('await runLocalDockerMigrations()') < smokeScript.indexOf('if (localServicesAreRunning())'),
    'local migrations must run before reusing or starting local app services',
  );
  assert.ok(
    smokeScript.indexOf('await runLocalDockerMigrations()') < smokeScript.indexOf("await waitForCheck('API health'"),
    'local migrations must run before API readiness assertions',
  );
});

test('CI runs the local Docker smoke before production Docker image gates', () => {
  const workflow = readRepoFile('.github/workflows/ci.yml');

  assert.match(workflow, /name:\s+Smoke local Docker app stack/);
  assert.match(workflow, /run:\s+npm run test:local-docker:smoke -- --cleanup --cleanup-volumes/);
  assert.ok(
    workflow.indexOf('name: Test') < workflow.indexOf('name: Smoke local Docker app stack'),
    'local Docker smoke must run after static tests',
  );
  assert.ok(
    workflow.indexOf('name: Smoke local Docker app stack') < workflow.indexOf('name: Build API Docker image'),
    'local Docker smoke must pass before production image gates',
  );
});
