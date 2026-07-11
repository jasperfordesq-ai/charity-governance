import { test, expect } from '../fixtures';
import { gotoWithDevServerRetry } from '../helpers/navigation';

test.describe('Privacy processing truth', () => {
  test('the public notice reports implemented provider boundaries without invented assurances', async ({ page }) => {
    await gotoWithDevServerRetry(page, '/privacy');

    await expect(page.getByRole('heading', { name: 'Privacy Policy' })).toBeVisible();
    await expect(page.getByText('Pre-launch draft - not approved for production')).toBeVisible();

    const notice = page.locator('.prose');
    await expect(notice).toContainText('application records in PostgreSQL through Prisma');
    await expect(notice).toContainText('Supabase integration is used only for private document object storage');
    await expect(notice).toContainText('Supabase Auth is not used');
    await expect(notice).toContainText(
      'does not store card numbers, card last-four values, or billing names',
    );
    await expect(notice).toContainText('Production legal bases have not yet been approved');
    await expect(notice).toContainText('does not yet have an approved production retention schedule');
    await expect(notice).toContainText('not a complete export of all personal data');
    await expect(notice).toContainText('No production privacy contact channel has yet been verified');

    const supabaseRow = notice.getByRole('row', { name: /Supabase/ });
    await expect(supabaseRow).toContainText('Private document object storage only');
    await expect(supabaseRow).toContainText('not yet verified');

    await expect(notice).not.toContainText('Database hosting and authentication');
    await expect(notice).not.toContainText('SCCs in place');
    await expect(notice).not.toContainText('Vercel');
    await expect(notice).not.toContainText('payment receipts');

    await page.evaluate(() => {
      localStorage.removeItem('cookie-consent');
      localStorage.removeItem('cookie-notice');
    });
    await page.reload();
    const cookieNotice = page.getByRole('dialog', { name: 'Cookie information' });
    await expect(cookieNotice).toContainText('strictly necessary authentication cookies');
    await expect(cookieNotice).toContainText('does not set analytics or advertising cookies');
    await expect(cookieNotice.getByRole('button', { name: 'Continue with essential cookies' })).toBeVisible();
    await expect(cookieNotice.getByRole('button', { name: 'Accept All' })).toHaveCount(0);
  });
});
