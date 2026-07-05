import { test, expect, uniqueEmail, sendInviteViaUi, acceptInviteViaUi } from '../fixtures';
import { setInviteToken, getUserAndOrg } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

const FUTURE_DATE = `${new Date().getFullYear()}-12-31`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('Deadlines & Team', () => {
  test('create a deadline then mark it complete', async ({ ownerPage }) => {
    const title = `E2E Annual Report filing ${Date.now()}`;

    await gotoWithDevServerRetry(ownerPage, '/deadlines');
    await expect(ownerPage.getByRole('heading', { name: 'Deadline Tracker' })).toBeVisible();

    // Open the modal (header button) — there is a second "Add Deadline" in the footer.
    await ownerPage.getByRole('button', { name: 'Add Deadline' }).first().click();
    const dialog = ownerPage.getByRole('dialog');
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByLabel('Due Date').fill(FUTURE_DATE);
    await dialog.getByRole('button', { name: 'Add Deadline' }).click();

    // The new deadline appears in the list.
    await expect(ownerPage.getByText(title)).toBeVisible();

    // Mark it complete and confirm the state flips.
    const completePatch = ownerPage.waitForResponse(
      (r) => /\/api\/v1\/deadlines\//.test(r.url()) && r.request().method() === 'PATCH',
    );
    await ownerPage.getByRole('checkbox', { name: new RegExp(`^Mark ${escapeRegExp(title)} as complete$`) }).click();
    expect((await completePatch).ok()).toBeTruthy();

    await expect(
      ownerPage.getByRole('checkbox', { name: new RegExp(`^Mark ${escapeRegExp(title)} as incomplete$`) }),
    ).toBeVisible();
  });

  test('invite a team member who then accepts and joins the workspace', async ({ ownerPage, owner, browser }) => {
    const inviteeEmail = uniqueEmail('invitee');

    // 1. OWNER sends an invite (HTTP 202, generic message; a pending row appears).
    await gotoWithDevServerRetry(ownerPage, '/team');
    await sendInviteViaUi(ownerPage, inviteeEmail, 'Member');
    await expect(ownerPage.getByText(/Invite sent\./).last()).toBeVisible();
    await expect(ownerPage.getByText(inviteeEmail)).toBeVisible();

    // 2. The plaintext invite token is unrecoverable (stored hashed), so set a
    //    known token on the invite row, then accept via the public page.
    const token = await setInviteToken(inviteeEmail);

    const acceptContext = await browser.newContext();
    const acceptPage = await acceptContext.newPage();
    try {
      await acceptInviteViaUi(acceptPage, token, 'Invited Teammate', 'Password123');

      // The new user belongs to the inviting owner's organisation.
      const invitee = await getUserAndOrg(inviteeEmail);
      expect(invitee.organisationId).toBe(owner.organisationId);
    } finally {
      await acceptContext.close();
    }
  });
});
