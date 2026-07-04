import { test as base, expect, type Page, type Locator, type BrowserContext } from '@playwright/test';
import { getUserAndOrg, markEmailVerified } from './helpers/db';

/**
 * Fill a HeroUI/React-Aria controlled input and confirm the value actually
 * stuck. These inputs are controlled by React state (value={state}); a fill
 * that lands before Next.js hydration sets the DOM value, but hydration then
 * resets the input to the (empty) state — so the submitted value is blank.
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

/** A unique email per call — registration is anti-enumeration, so emails must not repeat. */
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
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await fill();
    await page.getByRole('button', { name: submitName }).click();
    try {
      await page.waitForURL(expectedUrl, { timeout: 8000 });
      return;
    } catch {
      if (!formUrl.test(page.url())) throw new Error(`Unexpected navigation to ${page.url()}`);
      await page.waitForLoadState('domcontentloaded'); // native submit reloaded the form; retry.
    }
  }
  await expect(page).toHaveURL(expectedUrl);
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

  await page.goto('/register', { waitUntil: 'domcontentloaded' });
  await fillAndSubmit(
    page,
    async () => {
      await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
      await reliableFill(page.getByLabel('Your name'), name);
      await reliableFill(page.getByLabel('Email address'), opts.email);
      await reliableFill(page.getByLabel('Password', { exact: true }), password);
      await reliableFill(page.getByLabel('Confirm password'), password);
      await reliableFill(page.getByLabel('Organisation name'), organisationName);
    },
    'Create account',
    /\/verify-email/,
    /\/register/,
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
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await fillAndSubmit(
    page,
    async () => {
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
      await reliableFill(page.getByLabel('Email address'), email);
      // Exact match avoids the adjacent "Show password" toggle button.
      await reliableFill(page.getByLabel('Password', { exact: true }), password);
    },
    'Sign in',
    /\/dashboard/,
    /\/login/,
  );
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
}

/**
 * Pick an option from a HeroUI <Select>. The trigger is a button whose
 * accessible name is the Select's label; choosing is click-trigger then
 * click-option in the popup listbox.
 */
export async function selectHeroUiOption(
  scope: Page,
  triggerName: string | RegExp,
  optionName: string | RegExp,
): Promise<void> {
  await scope.getByRole('button', { name: triggerName }).click();
  await scope.getByRole('option', { name: optionName }).click();
}

/**
 * Send a team invite from the (authenticated) Team page. Robust against the
 * hydration race: retries fill+submit until the /team/invites POST actually
 * fires (a native GET submit produces none and reloads the page).
 */
export async function sendInviteViaUi(page: Page, email: string, roleLabel = 'Member'): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Team & Permissions' })).toBeVisible();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await reliableFill(page.getByLabel('Email'), email);
    await selectHeroUiOption(page, 'Role', roleLabel);
    const posted = page
      .waitForResponse(
        (r) => /\/api\/v1\/team\/invites/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 8000 },
      )
      .catch(() => null);
    await page.getByRole('button', { name: 'Send Invite' }).click();
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
  await page.goto(`/accept-invite#token=${token}`);
  await fillAndSubmit(
    page,
    async () => {
      await expect(page.getByRole('heading', { name: 'Accept your invite' })).toBeVisible();
      await reliableFill(page.getByLabel('Your name'), name);
      await reliableFill(page.getByLabel('Password', { exact: true }), password);
      await reliableFill(page.getByLabel('Confirm password'), password);
    },
    'Join Workspace',
    /\/dashboard/,
    /\/accept-invite/,
  );
}

interface Fixtures {
  /** A page already authenticated as the shared worker OWNER. */
  ownerPage: Page;
}

interface WorkerFixtures {
  /** The shared verified OWNER, registered once per worker (keeps us under the 5/min auth rate limit). */
  owner: OwnerInfo;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  owner: [
    async ({ browser }, use) => {
      const context = await browser.newContext();
      const page = await context.newPage();

      const email = uniqueEmail();
      const creds = await registerViaUi(page, { email, name: 'Shared Owner', organisationName: 'Shared E2E Charity' });
      // Fast-path verification via DB; the real verify flow is covered by auth.spec.ts.
      await markEmailVerified(creds.email);
      await loginViaUi(page, creds.email, creds.password);

      const { userId, organisationId } = await getUserAndOrg(creds.email);
      const storageState = await context.storageState();
      await context.close();

      await use({
        email: creds.email,
        password: creds.password,
        name: creds.name,
        organisationName: creds.organisationName,
        userId,
        organisationId,
        storageState,
      });
    },
    { scope: 'worker', timeout: 180_000 },
  ],

  ownerPage: async ({ browser, owner }, use) => {
    const context = await browser.newContext({ storageState: owner.storageState });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };
