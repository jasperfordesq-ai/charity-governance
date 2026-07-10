import { test, expect, uniqueEmail } from '../fixtures';
import {
  createAuthenticatedStorageState,
  createVerifiedMember,
} from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

/**
 * Concern: authorization (UI). A MEMBER must never see or trigger admin-only actions.
 * A verified MEMBER is provisioned directly inside the shared disposable organisation,
 * then receives a real database-backed authenticated session. On the Team page the MEMBER
 * sees the invite form DISABLED, the "owners and admins only" note, and NO per-member role
 * selector. Invitation acceptance is covered separately so failures here remain attributable
 * to the MEMBER authorization surface itself.
 */
test.describe('Authorization (UI)', () => {
  test('a MEMBER sees admin-only team controls disabled/hidden', async ({
    owner,
    newFencedContext,
  }) => {
    const memberSession = await test.step(
      'provision a verified MEMBER session in the owner organisation',
      async () => {
        const member = await createVerifiedMember({
          email: uniqueEmail('member'),
          name: 'Member User',
          organisationId: owner.organisationId,
        });
        expect(member.organisationId).toBe(owner.organisationId);
        expect(member.role).toBe('MEMBER');
        const storageState = await createAuthenticatedStorageState({
          userId: member.userId,
          organisationId: member.organisationId,
          role: member.role,
        });
        return { storageState };
      },
      { timeout: 60_000 },
    );

    const memberContext = await newFencedContext({
      storageState: memberSession.storageState,
    });
    const memberPage = await memberContext.newPage();

    await test.step(
      'open the Team page as the provisioned MEMBER',
      async () => {
        await gotoWithDevServerRetry(memberPage, '/team');
        await expect(
          memberPage.getByRole('heading', { name: 'Team & Permissions' }),
        ).toBeVisible({ timeout: 30_000 });
      },
      { timeout: 180_000 },
    );

    await test.step('verify MEMBER admin controls are disabled or absent', async () => {
      await expect(
        memberPage.getByRole('button', { name: 'Send Invite' }),
      ).toBeDisabled();
      await expect(
        memberPage
          .getByText(/only owners and admins can send or revoke invites/i)
          .first(),
      ).toBeVisible();
      await expect(
        memberPage.getByRole('button', { name: /^Role for / }),
      ).toHaveCount(0);
    });
  });
});
