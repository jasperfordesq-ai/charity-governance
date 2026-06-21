import { test, expect, uniqueEmail, reliableFill } from '../fixtures';

/**
 * Concern: input-validation parity. The register form now validates with the SAME shared
 * Zod schema the server uses. A long-but-weak password (8 lowercase letters) passes a
 * naive length check but fails the shared complexity rule — it must be flagged inline and
 * NEVER submitted as a guaranteed-400.
 */
test.describe('Input-validation parity (UI)', () => {
  test('register flags a long-but-weak password and sends no register request', async ({ page }) => {
    let registerPosted = false;
    page.on('request', (r) => {
      if (r.url().includes('/auth/register') && r.method() === 'POST') registerPosted = true;
    });

    await page.goto('/register');
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();

    // Confirm React has hydrated BEFORE we submit: the password-strength meter renders only
    // from React state, so its appearance proves the controlled inputs (and the form's
    // submit handler) are attached — a pre-hydration submit would be a native GET instead.
    await reliableFill(page.getByLabel('Password', { exact: true }), 'testpass'); // 8 lowercase, no upper/digit
    await expect(page.getByText('8+ characters')).toBeVisible({ timeout: 30_000 });

    await reliableFill(page.getByLabel('Your name'), 'Weak Password User');
    await reliableFill(page.getByLabel('Email address'), uniqueEmail('weakpw'));
    await reliableFill(page.getByLabel('Confirm password'), 'testpass');
    await reliableFill(page.getByLabel('Organisation name'), 'Weak PW Charity');

    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForTimeout(1500); // give any (wrongly-sent) register POST time to fire

    // The shared schema rejects it client-side: the field is flagged invalid and shows the
    // complexity message, we stay on /register, and NO guaranteed-400 payload is sent.
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Password must contain at least one uppercase letter')).toBeVisible();
    await expect(page).toHaveURL(/\/register/);
    expect(registerPosted).toBe(false);
  });
});
