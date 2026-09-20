


import type { Page } from '@playwright/test';
// test and expect come from the fixtures, not from Playwright: the fixture
// installs an origin fence that fails a test whose page talks to an
// unexpected origin, and importing around it opts out of that silently.
import { test, expect } from '../fixtures';
import { uniqueEmail } from '../fixtures';
import { fromBase32, totp } from '../../apps/api/src/utils/totp';
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

let tenantName = '';
let tenantOrganisationId = '';
/** The operator who made the configuration change the history test asserts. */
let configuringOperator = '';

test.beforeAll(async () => {
  tenantName = `Console Probe Charity ${Date.now()}`;
  const owner = await createVerifiedOwner({
    email: uniqueEmail('console-tenant'),
    password: TENANT_PASSWORD,
    name: 'Tenant Owner',
    organisationName: tenantName,
  });
  tenantOrganisationId = owner.organisationId;
});

/**
 * A fresh operator per test, signed in on the fixture's own page.
 *
 * Two constraints meet here. The sign-in route limits attempts per email
 * address, so a suite that signed in eight times as one operator spent that
 * budget and hung on a redirect that was never coming. And a spec may not
 * create its own browser context: the fixture installs an origin fence that
 * fails the test if the page talks to an unexpected origin, and a raw context
 * would quietly opt out of it.
 *
 * Seeding an operator is one insert, so one each is cheaper than sharing.
 */
async function signInAsNewOperator(page: Page): Promise<string> {
  const email = uniqueEmail('operator');
  await createPlatformOperator({ email, name: 'Console Operator', password: OPERATOR_PASSWORD });

  await page.goto('/owner/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByRole('textbox', { name: /password/i }).fill(OPERATOR_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/owner/tenants');
  return email;
}

/**
 * Picks an option from a HeroUI select.
 *
 * Located by test id rather than by accessible name: the trigger is a button
 * whose name HeroUI composes from the label and the current value, so a
 * pattern that matches before a value is chosen stops matching afterwards.
 *
 * Each attempt starts from a CLOSED listbox. The first version of this checked
 * whether the option was already visible and skipped reopening if it was, which
 * meant a retry could click into a listbox that was still re-rendering: on CI
 * that produced "element is not stable", then "element was detached from the
 * DOM", until the retry budget ran out. Pressing Escape and reopening makes
 * every attempt identical, and the timeouts are generous because a hosted
 * runner animates more slowly than a developer's machine.
 */
async function choose(page: Page, testId: string, option: string): Promise<void> {
  const trigger = page.getByTestId(testId).getByRole('button').last();
  const item = page.getByRole('option', { name: option, exact: true });

  await expect(async () => {
    await page.keyboard.press('Escape');
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await expect(item).toBeVisible({ timeout: 5_000 });
    await item.click({ timeout: 5_000 });
    await expect(trigger).toContainText(option, { timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}
test('a wrong password does not sign anybody in', async ({ page }) => {
  const operatorEmail = uniqueEmail('operator');
  await createPlatformOperator({
    email: operatorEmail,
    name: 'Console Operator',
    password: OPERATOR_PASSWORD,
  });

  await page.goto('/owner/login');
  await page.getByLabel(/email/i).fill(operatorEmail);
  await page.getByLabel(/password/i).fill('not-the-password');
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page).toHaveURL(/\/owner\/login/);
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('an operator signs in and sees the charity, with their own name in the bar', async ({ page }) => {
  const operatorEmail = await signInAsNewOperator(page);

  await expect(page.getByRole('link', { name: tenantName })).toBeVisible();
  // Until this shipped the console said nothing about whose account was acting,
  // although every action is recorded against it in somebody else's audit trail.
  await expect(page.getByTestId('owner-identity')).toContainText(operatorEmail);
});

test('the tenant list can be filtered by status', async ({ page }) => {
  const operatorEmail = await signInAsNewOperator(page);

  await choose(page, 'status-filter', 'Closed');

  await expect(page.getByRole('link', { name: tenantName })).toHaveCount(0);
});

test('a configuration change is saved, and recorded against the operator', async ({ page }) => {
  const operatorEmail = await signInAsNewOperator(page);
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
  configuringOperator = operatorEmail;
  expect(audit[0]!.reason).toBe(reason);
  expect(audit[0]!.context).toMatchObject({ newDocumentStorageProvider: 'local' });
});

test('the history shows the change that was just made, and who made it', async ({ page }) => {
  const operatorEmail = await signInAsNewOperator(page);
  await page.goto(`/owner/tenants/${tenantOrganisationId}`);

  const history = page.getByTestId('tenant-history');
  await expect(history).toContainText('Configuration changed');
  await expect(history).toContainText(configuringOperator);
  await expect(history).toContainText('storage set to local');
  await expect(history, 'the reason is the point of asking for one').toContainText(
    'keep their files on their own server',
  );
});

test('a change cannot be saved without a reason', async ({ page }) => {
  const operatorEmail = await signInAsNewOperator(page);
  await page.goto(`/owner/tenants/${tenantOrganisationId}`);

  await choose(page, 'tenant-plan', 'Complete');

  await expect(page.getByTestId('save-configuration').getByRole('button')).toBeDisabled();

  const row = await readTenantConfigurationRow(tenantOrganisationId);
  expect(row.plan, 'nothing may be written while the button is disabled').not.toBe('COMPLETE');
});

test('the plan can be changed, and the charity keeps the storage it was given', async ({ page }) => {
  const operatorEmail = await signInAsNewOperator(page);
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
  const operatorEmail = await signInAsNewOperator(page);
  await page.getByRole('button', { name: /sign out/i }).click();
  await page.waitForURL('**/owner/login');

  await page.goto('/owner/tenants');
  await expect(page).toHaveURL(/\/owner\/login/);
});

test('a tenant session is not an operator session', async ({ page }) => {
  // The two realms use different credentials and different cookie paths. A
  // charity's owner signing in to the application must not find the platform
  // console open to them.
  const operatorEmail = uniqueEmail('operator');
  await createPlatformOperator({
    email: operatorEmail,
    name: 'Console Operator',
    password: OPERATOR_PASSWORD,
  });

  await page.goto('/login');
  await page.getByLabel(/email/i).fill(operatorEmail);
  // The tenant form has a "show password" button that also answers to the
  // label, so the field has to be asked for as a textbox.
  await page.getByRole('textbox', { name: /password/i }).fill(OPERATOR_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.goto('/owner/tenants');
  await expect(page).toHaveURL(/\/owner\/login/);
});

/**
 * Concern: the second factor, from enrolment to a sign-in that needs it.
 *
 * The unit tests prove each piece against a stub. This proves the loop closes:
 * a code generated from the secret the console handed out actually signs the
 * operator in, against a real database and a real session.
 */
test.describe('Operator second factor', () => {
  let factorEmail = '';
  let enrolmentSecret = '';

  /**
   * Signs in as the factor account on the fixture's own page.
   *
   * Counted carefully: the route allows five attempts a minute per address, and
   * these tests make four between them. A spec may not open its own browser
   * context to keep a session alive, because the fixture installs an origin
   * fence that a raw context would quietly opt out of.
   */
  async function signInAsFactorOperator(page: Page): Promise<void> {
    await page.goto('/owner/login');
    await page.getByLabel(/email/i).fill(factorEmail);
    await page.getByRole('textbox', { name: /password/i }).fill(OPERATOR_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
  }

  test.beforeAll(async () => {
    // Its own operator: enrolling changes how that account signs in, and the
    // tests above expect theirs to keep working on a password alone.
    factorEmail = uniqueEmail('factor-operator');
    await createPlatformOperator({
      email: factorEmail,
      name: 'Second Factor Operator',
      password: OPERATOR_PASSWORD,
    });
  });

  test('enrolment needs a proved code, and then hands back recovery codes', async ({ page }) => {
    await signInAsFactorOperator(page);
    await page.waitForURL('**/owner/tenants');
    await page.goto('/owner/security');

    await expect(page.getByTestId('second-factor-status')).toContainText('Password only');

    await page.getByTestId('begin-second-factor').click();
    await expect(page.getByTestId('enrolment')).toBeVisible();
    enrolmentSecret = (await page.locator('span.font-mono').first().innerText()).trim();
    expect(enrolmentSecret).toMatch(/^[A-Z2-7]{32}$/);

    // Scanning is not enrolling: a setup scanned into the wrong application
    // must not lock anybody out.
    await expect(page.getByTestId('second-factor-status')).toContainText('Password only');

    // HeroUI's Input does not forward data attributes to the element it
    // renders, unlike its Chip and Button, so this one is found by its label.
    await page
      .getByRole('textbox', { name: /code from the application/i })
      .fill(totp(fromBase32(enrolmentSecret)));
    await page.getByTestId('confirm-second-factor').click();

    await expect(page.getByTestId('recovery-codes')).toBeVisible();
    const codes = (await page.getByTestId('recovery-codes').locator('li').allInnerTexts()).map(
      (code) => code.trim(),
    );
    expect(codes.length).toBe(10);
    expect(new Set(codes).size, 'every code must be distinct').toBe(10);

    await expect(page.getByTestId('second-factor-status')).toContainText('Second factor on');
  });

  test('the password alone no longer signs that account in', async ({ page }) => {
    await signInAsFactorOperator(page);

    await expect(page.getByTestId('second-factor')).toBeVisible();
    await expect(page).toHaveURL(/\/owner\/login/);
  });

  test('a code generated from that secret signs in', async ({ page }) => {
    await signInAsFactorOperator(page);
    await expect(page.getByTestId('second-factor')).toBeVisible();

    await page
      .getByRole('textbox', { name: /authentication code/i })
      .fill(totp(fromBase32(enrolmentSecret)));
    await page.getByRole('button', { name: /^sign in$/i }).click();

    await page.waitForURL('**/owner/tenants');
  });
  test('a recovery code signs in once, and not twice', async ({ page }) => {
    // Its own operator, enrolled in its own right. The sign-in route limits
    // attempts per email address, and this test makes four on its own; sharing
    // an account with the tests above spent that budget and left this one
    // waiting on a redirect that was never coming.
    const email = uniqueEmail('recovery-operator');
    await createPlatformOperator({
      email,
      name: 'Recovery Operator',
      password: OPERATOR_PASSWORD,
    });

    await page.goto('/owner/login');
    await page.getByLabel(/email/i).fill(email);
    await page.getByRole('textbox', { name: /password/i }).fill(OPERATOR_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/owner/tenants');

    await page.goto('/owner/security');
    await page.getByTestId('begin-second-factor').click();
    await expect(page.getByTestId('enrolment')).toBeVisible();
    const secret = (await page.locator('span.font-mono').first().innerText()).trim();
    await page
      .getByRole('textbox', { name: /code from the application/i })
      .fill(totp(fromBase32(secret)));
    await page.getByTestId('confirm-second-factor').click();
    await expect(page.getByTestId('recovery-codes')).toBeVisible();
    const codes = (await page.getByTestId('recovery-codes').locator('li').allInnerTexts()).map(
      (code) => code.trim(),
    );
    const code = codes[0]!;

    async function attemptWithRecoveryCode(): Promise<void> {
      await page.goto('/owner/login');
      await page.getByLabel(/email/i).fill(email);
      await page.getByRole('textbox', { name: /password/i }).fill(OPERATOR_PASSWORD);
      await page.getByRole('button', { name: /sign in/i }).click();
      await expect(page.getByTestId('second-factor')).toBeVisible();
      await page.getByRole('button', { name: /lost my authenticator/i }).click();
      await page.getByRole('textbox', { name: /recovery code/i }).fill(code);
      await page.getByRole('button', { name: /^sign in$/i }).click();
    }

    await attemptWithRecoveryCode();
    await page.waitForURL('**/owner/tenants');

    // Signed out through the console rather than by clearing cookies, which
    // aborts the navigation that follows it.
    await page.getByRole('button', { name: /sign out/i }).click();
    await page.waitForURL('**/owner/login');

    await attemptWithRecoveryCode();
    await expect(page, 'a spent recovery code buys nothing').toHaveURL(/\/owner\/login/);
  });
});
