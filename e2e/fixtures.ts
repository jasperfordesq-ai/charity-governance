import { test as base, expect, type Page, type Locator, type BrowserContext } from '@playwright/test';
import { deployedQaOwnerCredentials, IS_DEPLOYED_QA } from './env';
import { createAuthenticatedStorageState, createVerifiedOwner } from './helpers/db';
import { gotoWithDevServerRetry } from './helpers/navigation';

/**
 * Fill a HeroUI/React-Aria controlled input and confirm the value actually
 * stuck. These inputs are controlled by React state (value={state}); a fill
 * that lands before Next.js hydration sets the DOM value, but hydration then
 * resets the input to the (empty) state - so the submitted value is blank.
 * Re-filling until toHaveValue passes both fixes the race and proves the field
 * is hydrated and wired to its onValueChange handler.
 */
export async function reliableFill(locator: Locator, value: string): Promise<void> {
  await expect(async () => {
    await locator.fill('');
    await locator.fill(value);
    await expect(locator).toHaveValue(value, { timeout: 1500 });
  }).toPass({ timeout: 15000 });
}

/**
 * A password that satisfies the API's Zod policy everywhere
 * (>=8 chars, an uppercase, a lowercase and a digit).
 */
export const TEST_PASSWORD = 'TestPass123';
const AUTHENTICATED_OWNER_SETUP_TIMEOUT_MS = 900_000;
const AUTH_FORM_HEADING_TIMEOUT_MS = 60_000;
const POST_LOGIN_DASHBOARD_TIMEOUT_MS = IS_DEPLOYED_QA ? 60_000 : 180_000;
const AUTH_FORM_HYDRATION_SETTLE_MS = IS_DEPLOYED_QA ? 0 : 1_000;

async function suppressCookieConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('cookie-consent', 'declined');
  });
}

/** A unique email per call - registration is anti-enumeration, so emails must not repeat. */
export function uniqueEmail(prefix = 'owner'): string {
  return `e2e-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

export interface OwnerInfo {
  email: string;
  password: string;
  name: string;
  organisationName: string;
  userId: string;
  organisationId: string;
  /** Cookies/origins captured after login, for reuse via context.storageState. */
  storageState: Awaited<ReturnType<BrowserContext['storageState']>>;
}

/**
 * Submit a form and confirm it navigated as expected, retrying through the
 * Next.js hydration window. Before hydration a type=submit click triggers a
 * NATIVE GET submit (reloading to the same path with a `?`), so no API request
 * fires. Native GETs don't consume the auth rate limit, so retrying is cheap;
 * we re-run the fill each attempt because a native reload clears the fields.
 */
async function fillAndSubmit(
  page: Page,
  fill: () => Promise<void>,
  submitName: string,
  expectedUrl: RegExp,
  formUrl: RegExp,
  formPath: string,
  submitRequest?: { url: RegExp; method: string },
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.waitForLoadState('load').catch(() => undefined);
    if (AUTH_FORM_HYDRATION_SETTLE_MS > 0) {
      await page.waitForTimeout(AUTH_FORM_HYDRATION_SETTLE_MS);
    }
    await fill();
    const submitted = submitRequest
      ? page
          .waitForResponse(
            (r) => submitRequest.url.test(r.url()) && r.request().method() === submitRequest.method,
            { timeout: 10_000 },
          )
          .catch(() => null)
      : Promise.resolve(null);
    await page.getByRole('button', { name: submitName }).click({ noWaitAfter: true });
    const submitResponse = await submitted;
    if (submitRequest && !submitResponse) {
      await gotoWithDevServerRetry(page, formPath, { waitUntil: 'domcontentloaded' });
      continue;
    }
    if (submitResponse && !submitResponse.ok()) {
      const body = await submitResponse.text().catch(() => '');
      throw new Error(
        `${submitName} returned HTTP ${submitResponse.status()} for ${submitRequest?.url}${body ? `: ${body}` : ''}`,
      );
    }
    try {
      await page.waitForURL(expectedUrl, { timeout: 60_000 });
      return;
    } catch {
      if (expectedUrl.test(page.url())) return;
      if (!formUrl.test(page.url())) throw new Error(`Unexpected navigation to ${page.url()}`);
      await gotoWithDevServerRetry(page, formPath, { waitUntil: 'domcontentloaded' });
    }
  }
  await expect(page).toHaveURL(expectedUrl, { timeout: 60_000 });
}

async function expectAuthFormHeading(page: Page, path: string, heading: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible({
        timeout: AUTH_FORM_HEADING_TIMEOUT_MS,
      });
      return;
    } catch (err) {
      if (IS_DEPLOYED_QA || attempt === 2) {
        throw err;
      }
      await gotoWithDevServerRetry(page, path, { waitUntil: 'domcontentloaded' });
    }
  }
}

/**
 * Register a brand-new charity OWNER via the registration UI.
 * Returns the credentials used. Does NOT verify the email.
 */
export async function registerViaUi(
  page: Page,
  opts: { email: string; password?: string; name?: string; organisationName?: string },
): Promise<{ email: string; password: string; name: string; organisationName: string }> {
  const password = opts.password ?? TEST_PASSWORD;
  const name = opts.name ?? 'E2E Owner';
  const organisationName = opts.organisationName ?? 'E2E Test Charity';

  await suppressCookieConsent(page);
  await gotoWithDevServerRetry(page, '/register', { waitUntil: 'domcontentloaded' });
  await fillAndSubmit(
    page,
    async () => {
      await expectAuthFormHeading(page, '/register', 'Create your account');
      await reliableFill(page.getByLabel('Your name'), name);
      await reliableFill(page.getByLabel('Email address'), opts.email);
      await reliableFill(page.getByLabel('Password', { exact: true }), password);
      await reliableFill(page.getByLabel('Confirm password'), password);
      await reliableFill(page.getByLabel('Organisation name'), organisationName);
    },
    'Create account',
    /\/verify-email/,
    /\/register/,
    '/register',
    { url: /\/api\/v1\/auth\/register/, method: 'POST' },
  );

  return { email: opts.email, password, name, organisationName };
}

/**
 * Log in via the UI and wait for the dashboard. Requires a verified email.
 *
 * Guards against a Next.js hydration race: if the Sign-in button is clicked
 * before React attaches its submit handler, the form submits natively (GET to
 * /login?) and no /auth/login POST fires. We confirm the POST actually went out
 * and, if not, re-fill and retry until hydration completes.
 */
export async function loginViaUi(page: Page, email: string, password: string): Promise<void> {
  await suppressCookieConsent(page);
  await gotoWithDevServerRetry(page, '/login', { waitUntil: 'domcontentloaded' });
  await fillAndSubmit(
    page,
    async () => {
      await expectAuthFormHeading(page, '/login', 'Welcome back');
      await reliableFill(page.getByLabel('Email address'), email);
      // Exact match avoids the adjacent "Show password" toggle button.
      await reliableFill(page.getByLabel('Password', { exact: true }), password);
    },
    'Sign in',
    /\/dashboard/,
    /\/login/,
    '/login',
    { url: /\/api\/v1\/auth\/login/, method: 'POST' },
  );
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible({
    timeout: POST_LOGIN_DASHBOARD_TIMEOUT_MS,
  });
}

/**
 * Pick an option from a HeroUI <Select>. The trigger is a button whose
 * accessible name is the Select's label; choosing is click-trigger then
 * click-option in the popup listbox.
 */
export async function selectHeroUiOption(
  scope: Page | Locator,
  triggerName: string | RegExp,
  optionName: string | RegExp,
): Promise<void> {
  const trigger = scope.getByRole('button', { name: triggerName });
  if (typeof optionName === 'string' && (await trigger.textContent())?.includes(optionName)) {
    return;
  }
  await trigger.click();
  await scope.getByRole('option', { name: optionName }).click();
}

/**
 * Send a team invite from the (authenticated) Team page. Robust against the
 * hydration race: retries fill+submit until the /team/invites POST actually
 * fires (a native GET submit produces none and reloads the page).
 */
export async function sendInviteViaUi(page: Page, email: string, roleLabel = 'Member'): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Team & Permissions' })).toBeVisible({ timeout: 60_000 });
  const inviteForm = page.getByRole('group', { name: 'Invite someone' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await reliableFill(inviteForm.getByLabel('Email'), email);
    await selectHeroUiOption(inviteForm, 'Role', roleLabel);
    const posted = page
      .waitForResponse(
        (r) => /\/api\/v1\/team\/invites/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 8000 },
      )
      .catch(() => null);
    await inviteForm.getByRole('button', { name: 'Send Invite' }).click();
    if (await posted) return;
    await page.waitForLoadState('domcontentloaded');
  }
  throw new Error('Send Invite never produced a /team/invites POST (hydration?)');
}

/** Accept a team invite via the public page, robust against the hydration race. */
export async function acceptInviteViaUi(
  page: Page,
  token: string,
  name: string,
  password: string,
): Promise<void> {
  await suppressCookieConsent(page);
  await gotoWithDevServerRetry(page, `/accept-invite#token=${token}`);
  await fillAndSubmit(
    page,
    async () => {
      await expectAuthFormHeading(page, `/accept-invite#token=${token}`, 'Accept your invite');
      await reliableFill(page.getByLabel('Your name'), name);
      await reliableFill(page.getByLabel('Password', { exact: true }), password);
      await reliableFill(page.getByLabel('Confirm password'), password);
    },
    'Join Workspace',
    /\/dashboard/,
    /\/accept-invite/,
    `/accept-invite#token=${token}`,
    { url: /\/api\/v1\/team\/accept-invite/, method: 'POST' },
  );
}

interface Fixtures {
  /** A page already authenticated as the shared worker OWNER. */
  ownerPage: Page;
}

interface WorkerFixtures {
  /** The shared verified OWNER, created once per worker (keeps us under the 5/min auth rate limit). */
  owner: OwnerInfo;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  owner: [
    async ({ browser }, use) => {
      if (IS_DEPLOYED_QA) {
        const context = await browser.newContext();
        const page = await context.newPage();
        const existingOwner = deployedQaOwnerCredentials();
        await loginViaUi(page, existingOwner.email, existingOwner.password);

        const storageState = await context.storageState();
        await context.close();

        await use({
          email: existingOwner.email,
          password: existingOwner.password,
          name: 'Existing QA Owner',
          organisationName: 'Existing QA Workspace',
          userId: 'deployed-qa-existing-user',
          organisationId: 'deployed-qa-existing-organisation',
          storageState,
        });
        return;
      }

      const email = uniqueEmail();
      const password = TEST_PASSWORD;
      const name = 'Shared Owner';
      const organisationName = 'Shared E2E Charity';
      const { userId, organisationId } = await createVerifiedOwner({ email, password, name, organisationName });
      const storageState = await createAuthenticatedStorageState({
        userId,
        organisationId,
        role: 'OWNER',
      });

      await use({
        email,
        password,
        name,
        organisationName,
        userId,
        organisationId,
        storageState,
      });
    },
    { scope: 'worker', timeout: AUTHENTICATED_OWNER_SETUP_TIMEOUT_MS },
  ],

  ownerPage: async ({ browser, owner }, use) => {
    const storageState = IS_DEPLOYED_QA
      ? owner.storageState
      : await createAuthenticatedStorageState({
          userId: owner.userId,
          organisationId: owner.organisationId,
          role: 'OWNER',
        });
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };
