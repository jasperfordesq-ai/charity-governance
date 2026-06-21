import { test, expect, uniqueEmail, sendInviteViaUi, acceptInviteViaUi } from '../fixtures';
import { setInviteToken } from '../helpers/db';

/**
 * Concern: authorization (UI). A MEMBER must never see or trigger admin-only actions.
 * An OWNER invites a MEMBER, who accepts and lands authenticated; on the Team page the
 * MEMBER sees the invite form DISABLED, the "owners and admins only" note, and NO
 * per-member role selector. The API enforces the same boundary independently (API ledger:
 * requireAdmin/requireOwner), so affordance AND enforcement both hold.
 */
test.describe('Authorization (UI)', () => {
  test('a MEMBER sees admin-only team controls disabled/hidden', async ({ ownerPage, browser }) => {
    const inviteeEmail = uniqueEmail('member');

    await ownerPage.goto('/team');
    await sendInviteViaUi(ownerPage, inviteeEmail, 'Member');
    const token = await setInviteToken(inviteeEmail);

    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    try {
      // Accept the invite — this signs the MEMBER in and lands on the dashboard.
      await acceptInviteViaUi(memberPage, token, 'Member User', 'MemberPass123');

      await memberPage.goto('/team');
      await expect(memberPage.getByRole('heading', { name: 'Team & Permissions' })).toBeVisible();

      // Affordance: invite controls are disabled and the explanatory note is shown.
      await expect(memberPage.getByRole('button', { name: 'Send Invite' })).toBeDisabled();
      await expect(memberPage.getByText(/only owners and admins can invite/i)).toBeVisible();

      // No per-member role selector is rendered for a MEMBER (owner-only control).
      await expect(memberPage.getByRole('button', { name: /^Role for / })).toHaveCount(0);
    } finally {
      await memberContext.close();
    }
  });
});
