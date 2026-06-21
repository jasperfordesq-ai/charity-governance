import { test, expect, uniqueEmail, reliableFill } from '../fixtures';

/**
 * Concern: input-validation parity. The register form now validates with the SAME shared
 * Zod schema the server uses. A long-but-weak password (8 lowercase letters) passes a
 * naive length check but fails the shared complexity rule — it must be caught inline and
 * NEVER submitted as a guaranteed-400.
 */
test.describe('Input-validation parity (UI)', () => {
  test('register blocks a long-but-weak password inline and sends no register request', async ({ page }) => {
    let registerPosted = false;
    page.on('request', (r) => {
      if (r.url().includes('/auth/register') && r.method() === 'POST') registerPosted = true;
    });

    await page.goto('/register');

    // Robust against the Next hydration window: re-fill + click until the client-side
    // validation (which only runs once hydrated) surfaces the shared schema's message.
    await expect(async () => {
      await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
      await reliableFill(page.getByLabel('Your name'), 'Weak Password User');
      await reliableFill(page.getByLabel('Email address'), uniqueEmail('weakpw'));
      await reliableFill(page.getByLabel('Password', { exact: true }), 'testpass'); // 8 lowercase, no upper/digit
      await reliableFill(page.getByLabel('Confirm password'), 'testpass');
      await reliableFill(page.getByLabel('Organisation name'), 'Weak PW Charity');
      await page.getByRole('button', { name: 'Create account' }).click();
      // Target the FORM's error banner specifically — Next renders an empty
      // role=alert route-announcer at the document root that would otherwise match.
      await expect(page.locator('form [role="alert"]')).toContainText(/uppercase/i, { timeout: 3000 });
    }).toPass({ timeout: 30000 });

    // We never left the form and no guaranteed-400 register payload was sent.
    await expect(page).toHaveURL(/\/register/);
    expect(registerPosted).toBe(false);
  });
});
