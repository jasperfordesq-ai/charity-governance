


import { test, expect, type Page } from '@playwright/test';
import { uniqueEmail } from '../fixtures';
import {
  createPlatformOperator,
  createVerifiedOwner,
  readConfigurationAudit,
  readTenantConfigurationRow,
} from '../helpers/db';

/**
 * Concern: the platform operator console.
 *
 * It has been well covered by unit and integration tests since it shipped and
 * has never been driven end to end, unlike every tenant-facing surface. That
 * matters more here than elsewhere: this console signs in with a separate
 * credential, sets its cookies on a separate path, and can suspend any charity
 * on the platform. None of that wiring is exercised by a test that stubs the
 * boundary it runs across.
 */
test.describe.configure({ mode: 'serial' });

const OPERATOR_PASSWORD = 'OperatorConsole!2026';
const TENANT_PASSWORD = 'TenantOwner!2026';

let operatorEmail = '';
let tenantName = '';
let tenantOrganisationId = '';
let consoleCookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> = [];

test.beforeAll(async () => {
  operatorEmail = uniqueEmail('operator');
  await createPlatformOperator({
    email: operatorEmail,
    name: 'Console Operator',
    password: OPERATOR_PASSWORD,
  });

  tenantName = `Console Probe Charity ${Date.now()}`;
  const owner = await createVerifiedOwner({
    email: uniqueEmail('console-tenant'),
    password: TENANT_PASSWORD,
    name: 'Tenant Owner',
    organisationName: tenantName,
  });
  tenantOrganisationId = owner.organisationId;
});

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInOn(page);
  consoleCookies = (await context.cookies()).filter((cookie) =>
    cookie.name.startsWith('charitypilot_owner'),
  );
  expect(consoleCookies.length, 'the console must set its own cookies').toBeGreaterThan(0);
  await context.close();
});

/**
 * Picks an option from a HeroUI select.
 *
 * Located by test id rather than by accessible name: the trigger is a button
 * whose name HeroUI composes from the label and the current value, so a
 * pattern that matches before a value is chosen stops matching afterwards.
 * The listbox is also replaced during its opening animation, so the click
 * stays inside the retry boundary and a detached option is re-resolved from a
 * freshly opened listbox rather than reported as a flaky failure.
 */
async function choose(page: Page, testId: string, option: string): Promise<void> {
  const trigger = page.getByTestId(testId).getByRole('button').last();
  await trigger.scrollIntoViewIfNeeded();
  const item = page.getByRole('option', { name: option, exact: true });
  await expect(async () => {
    if (!(await item.isVisible().catch(() => false))) {
      await trigger.click();
    }
    await item.click({ timeout: 2000 });
    await expect(trigger).toContainText(option, { timeout: 2000 });
  }).toPass({ timeout: 30_000 });
}
async function signInOn(page: Page): Promise<void> {
  await page.goto('/owner/login');
  await page.getByLabel(/email/i).fill(operatorEmail);
  await page.getByLabel(/password/i).fill(OPERATOR_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/owner/tenants');
}

/**
 * Restores the one signed-in session rather than signing in again.
 *
 * The operator sign-in route limits attempts per email address, as the tenant
 * one does. A suite that signed in for every test exhausted that budget part
 * way through and then hung on a redirect that was never coming — which is a
 * confusing way to be told the rate limiter works.
 */
async function useConsole(page: Page): Promise<void> {
  await page.context().addCookies(consoleCookies);
  await page.goto('/owner/tenants');
  await page.waitForURL('**/owner/tenants');
}

test('a wrong password does not sign anybody in', async ({ page }) => {
  await page.goto('/owner/login');
  await page.getByLabel(/email/i).fill(operatorEmail);
  await page.getByLabel(/password/i).fill('not-the-password');
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page).toHaveURL(/\/owner\/login/);
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('an operator signs in and sees the charity, with their own name in the bar', async ({ page }) => {
  await signInOn(page);

  await expect(page.getByRole('link', { name: tenantName })).toBeVisible();
  // Until this shipped the console said nothing about whose account was acting,
  // although every action is recorded against it in somebody else's audit trail.
  await expect(page.getByTestId('owner-identity')).toContainText(operatorEmail);
});

test('the tenant list can be filtered by status', async ({ page }) => {
  await useConsole(page);

  await choose(page, 'status-filter', 'Closed');

  await expect(page.getByRole('link', { name: tenantName })).toHaveCount(0);
});

test('a configuration change is saved, and recorded against the operator', async ({ page }) => {
  await useConsole(page);
  await page.getByRole('link', { name: tenantName }).click();
  await page.waitForURL(`**/owner/tenants/${tenantOrganisationId}`);

  const reason = 'The charity asked to keep their files on their own server';
  await choose(page, 'storage-provider', 'local');
  await page.getByTestId('configuration-reason').getByRole('textbox').fill(reason);
  await page.getByTestId('save-configuration').getByRole('button').click();

  await expect(page.getByText(/configuration saved/i)).toBeVisible();

  // The database is the assertion, not the screen: a console that said it saved
  // and did not would look identical.
  const row = await readTenantConfigurationRow(tenantOrganisationId);
  expect(row.documentStorageProvider).toBe('local');

  const audit = await readConfigurationAudit(tenantOrganisationId);
  expect(audit.length).toBe(1);
  expect(audit[0]!.actorLabel).toBe(operatorEmail);
  expect(audit[0]!.reason).toBe(reason);
  expect(audit[0]!.context).toMatchObject({ newDocumentStorageProvider: 'local' });
});

test('a change cannot be saved without a reason', async ({ page }) => {
  await useConsole(page);
  await page.goto(`/owner/tenants/${tenantOrganisationId}`);

  await choose(page, 'tenant-plan', 'Complete');

  await expect(page.getByTestId('save-configuration').getByRole('button')).toBeDisabled();

  const row = await readTenantConfigurationRow(tenantOrganisationId);
  expect(row.plan, 'nothing may be written while the button is disabled').not.toBe('COMPLETE');
});

test('the plan can be changed, and the charity keeps the storage it was given', async ({ page }) => {
  await useConsole(page);
  await page.goto(`/owner/tenants/${tenantOrganisationId}`);

  await choose(page, 'tenant-plan', 'Complete');
  await page.getByTestId('configuration-reason').getByRole('textbox').fill('Upgraded as agreed');
  await page.getByTestId('save-configuration').getByRole('button').click();

  await expect(page.getByText(/configuration saved/i)).toBeVisible();

  const row = await readTenantConfigurationRow(tenantOrganisationId);
  expect(row.plan).toBe('COMPLETE');
  expect(
    row.documentStorageProvider,
    'a save must not reset a setting the operator never touched',
  ).toBe('local');
});

test('signing out ends the session, and the console is closed again', async ({ page }) => {
  await useConsole(page);
  await page.getByRole('button', { name: /sign out/i }).click();
  await page.waitForURL('**/owner/login');

  await page.goto('/owner/tenants');
  await expect(page).toHaveURL(/\/owner\/login/);
});

test('a tenant session is not an operator session', async ({ page }) => {
  // The two realms use different credentials and different cookie paths. A
  // charity's owner signing in to the application must not find the platform
  // console open to them.
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(operatorEmail);
  // The tenant form has a "show password" button that also answers to the
  // label, so the field has to be asked for as a textbox.
  await page.getByRole('textbox', { name: /password/i }).fill(OPERATOR_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.goto('/owner/tenants');
  await expect(page).toHaveURL(/\/owner\/login/);
});
