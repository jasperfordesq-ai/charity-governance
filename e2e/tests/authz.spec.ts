import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, reliableFill, uniqueEmail } from '../fixtures';
import {
  createAuthenticatedStorageState,
  createVerifiedAdmin,
  createVerifiedMember,
  withDb,
} from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

const SAMPLE_FILE = path.resolve(__dirname, '../fixtures/sample-document.txt');
const SAMPLE_MARKER = 'CharityPilot E2E sample document';

/**
 * Concern: authorization (UI). A MEMBER must never see or trigger admin-only actions.
 * A verified MEMBER is provisioned directly inside the shared disposable organisation,
 * then receives a real database-backed authenticated session. The test walks the principal
 * governance routes to prove that legitimate reads remain available while write affordances
 * are hidden or read-only. Invitation acceptance is covered separately so failures here remain
 * attributable to the MEMBER authorization surface itself.
 */
test.describe('Authorization (UI)', () => {
  test('a MEMBER gets read-only governance routes without privileged mutation affordances', async ({
    owner,
    ownerPage,
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
        const subscriptionRows = await withDb(async (client) => {
          const result = await client.query(
            `UPDATE "Subscription"
                SET "plan" = 'COMPLETE', "updatedAt" = NOW()
              WHERE "organisationId" = $1`,
            [owner.organisationId],
          );
          return result.rowCount ?? 0;
        });
        expect(subscriptionRows).toBe(1);
        const storageState = await createAuthenticatedStorageState({
          userId: member.userId,
          organisationId: member.organisationId,
          role: member.role,
        });
        return { member, storageState };
      },
      { timeout: 60_000 },
    );

    const seededRecords = await test.step('seed representative trustee and private-document reads as the owner', async () => {
      const trusteeName = `Member review trustee ${Date.now()}`;
      await gotoWithDevServerRetry(ownerPage, '/board');
      await ownerPage.getByRole('button', { name: 'Add trustee' }).click();
      await reliableFill(ownerPage.getByLabel('Full name'), trusteeName);
      await reliableFill(ownerPage.getByLabel('Role'), 'Trustee');
      await reliableFill(ownerPage.getByLabel('Date appointed'), '2026-01-15');
      const boardPost = ownerPage.waitForResponse(
        (response) => /\/api\/v1\/board-members$/.test(response.url()) && response.request().method() === 'POST',
      );
      await ownerPage.getByRole('button', { name: 'Add trustee' }).last().click();
      expect((await boardPost).status()).toBe(201);
      await expect(ownerPage.getByRole('row').filter({ hasText: trusteeName })).toBeVisible();

      const documentName = `Member download evidence ${Date.now()}`;
      await gotoWithDevServerRetry(ownerPage, '/documents');
      await ownerPage.getByRole('button', { name: /Upload document/i }).click();
      await reliableFill(ownerPage.getByLabel('Document name'), documentName);
      await ownerPage.locator('#document-upload-file').setInputFiles(SAMPLE_FILE);
      const documentPost = ownerPage.waitForResponse(
        (response) => /\/api\/v1\/documents$/.test(response.url()) && response.request().method() === 'POST',
      );
      await ownerPage.getByRole('button', { name: 'Upload', exact: true }).click();
      expect((await documentPost).status()).toBe(201);
      await expect(ownerPage.getByText(documentName).first()).toBeVisible();

      return { documentName, trusteeName };
    }, { timeout: 180_000 });

    let memberContext = await newFencedContext({
      storageState: memberSession.storageState,
    });
    let memberPage = await memberContext.newPage();
    const privilegedMutationRequests: string[] = [];
    const trackPrivilegedWrites = (page: Page) => {
      page.on('request', (request) => {
        const method = request.method();
        const requestPath = new URL(request.url()).pathname;
        if (
          ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) &&
          requestPath.includes('/api/v1/') &&
          !requestPath.endsWith('/auth/refresh')
        ) {
          privilegedMutationRequests.push(`${method} ${requestPath}`);
        }
      });
    };
    trackPrivilegedWrites(memberPage);

    const rotateMemberBrowserSession = async () => {
      await memberContext.close();
      const storageState = await createAuthenticatedStorageState({
        userId: memberSession.member.userId,
        organisationId: memberSession.member.organisationId,
        role: memberSession.member.role,
      });
      memberContext = await newFencedContext({ storageState });
      memberPage = await memberContext.newPage();
      trackPrivilegedWrites(memberPage);
    };

    await test.step(
      'open the Team page as the provisioned MEMBER',
      async () => {
        await gotoWithDevServerRetry(memberPage, '/team');
        await expect(
          memberPage.getByRole('heading', { name: 'Team & Permissions', exact: true }),
        ).toBeVisible({ timeout: 30_000 });
      },
      { timeout: 180_000 },
    );

    await test.step('verify MEMBER admin controls are disabled or absent', async () => {
      await expect(
        memberPage.getByRole('button', { name: 'Send Invite' }),
      ).toHaveCount(0);
      await expect(
        memberPage
          .getByText(/members have read-only access to governance records/i)
          .first(),
      ).toBeVisible();
      await expect(
        memberPage.getByRole('button', { name: /^Role for / }),
      ).toHaveCount(0);
    });

    await test.step('review the board register without trustee mutations', async () => {
      await gotoWithDevServerRetry(memberPage, '/board');
      await expect(memberPage.getByRole('heading', { name: 'Board Members Register', exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(memberPage.getByText('Read-only board register', { exact: true })).toBeVisible();
      await expect(memberPage.getByRole('button', { name: 'Add trustee' })).toHaveCount(0);
      await expect(memberPage.getByRole('button', { name: 'Add first trustee' })).toHaveCount(0);
      const trusteeRow = memberPage.getByRole('row').filter({ hasText: seededRecords.trusteeName });
      await expect(trusteeRow).toBeVisible();
      await expect(trusteeRow.getByRole('button', { name: 'Edit' })).toHaveCount(0);
      await expect(trusteeRow.getByRole('button', { name: 'Deactivate' })).toHaveCount(0);
    });

    await test.step('review the document vault without upload or evidence-link mutations', async () => {
      await gotoWithDevServerRetry(memberPage, '/documents');
      await expect(memberPage.getByRole('heading', { name: 'Document Vault', exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(memberPage.getByText(/Uploads and evidence links are managed by owners and administrators/i)).toBeVisible();
      await expect(memberPage.getByRole('button', { name: 'Upload document' })).toHaveCount(0);
      await expect(memberPage.getByRole('button', { name: 'Upload first document' })).toHaveCount(0);
      const documentRow = memberPage.getByRole('article').filter({ hasText: seededRecords.documentName });
      await expect(documentRow).toBeVisible();
      await expect(documentRow.getByRole('button', { name: /Link .* to a standard/i })).toHaveCount(0);
      await expect(documentRow.getByRole('button', { name: /Delete /i })).toHaveCount(0);

      const downloadResponse = memberPage.waitForResponse(
        (response) => /\/api\/v1\/documents\/[^/]+\/download$/.test(response.url()) && response.status() === 200,
      );
      const downloadArtifact = memberPage.waitForEvent('download');
      await documentRow.getByRole('button', { name: `Download ${seededRecords.documentName}` }).click();
      expect((await downloadResponse).status()).toBe(200);
      const downloadedPath = await (await downloadArtifact).path();
      expect(downloadedPath).toBeTruthy();
      expect((await readFile(downloadedPath!)).toString('utf8')).toContain(SAMPLE_MARKER);
    });

    await test.step('rotate the disposable member session before the next route group', rotateMemberBrowserSession);

    await test.step('open compliance records in view-only mode', async () => {
      await gotoWithDevServerRetry(memberPage, '/compliance');
      await expect(memberPage.getByRole('heading', { name: 'Compliance Overview', exact: true })).toBeVisible({ timeout: 30_000 });
      const viewRecords = memberPage.getByRole('button', { name: 'View records' });
      await expect(viewRecords.first()).toBeVisible({ timeout: 30_000 });
      await expect(memberPage.getByRole('button', { name: 'Edit records' })).toHaveCount(0);
      await viewRecords.first().click();
      await expect(memberPage.getByText('View only').first()).toBeVisible({ timeout: 30_000 });
      await expect(memberPage.getByLabel('Action Taken').first()).not.toBeEditable();
    });

    await test.step('review Complete-plan registers without record or readiness mutations', async () => {
      await gotoWithDevServerRetry(memberPage, '/registers');
      await expect(memberPage.getByRole('heading', { name: 'Governance Registers', exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(memberPage.getByText(/You have read-only access/i).first()).toBeVisible({ timeout: 30_000 });
      await expect(memberPage.getByRole('button', { name: /^Add (conflict|risk|complaint|activity)$/ })).toHaveCount(0);
      await expect(memberPage.getByRole('button', { name: /Save Annual Report readiness/i })).toHaveCount(0);
      await expect(memberPage.getByRole('button', { name: /Save controls review/i })).toHaveCount(0);
      await expect(memberPage.getByLabel('Activities narrative')).not.toBeEditable();
    });

    await test.step('review deadlines without calendar mutations or reminder-delivery audit data', async () => {
      await gotoWithDevServerRetry(memberPage, '/deadlines');
      await expect(memberPage.getByRole('heading', { name: 'Deadline Tracker', exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(memberPage.getByRole('button', { name: 'Add deadline' })).toHaveCount(0);
      await expect(memberPage.getByText('Reminder delivery history')).toHaveCount(0);
    });

    await test.step('rotate the disposable member session before the final route group', rotateMemberBrowserSession);

    await test.step('review the organisation profile without editable state', async () => {
      await gotoWithDevServerRetry(memberPage, '/organisation');
      await expect(memberPage.getByRole('heading', { name: 'Organisation Profile', exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(memberPage.getByLabel('Organisation name')).not.toBeEditable();
      await expect(memberPage.getByRole('button', { name: 'Save profile' })).toHaveCount(0);
      await expect(memberPage.getByText(/Organisation profile changes are available to owners and administrators/i)).toBeVisible();
    });

    await test.step('review export and board sign-off without approval mutations', async () => {
      await gotoWithDevServerRetry(memberPage, '/export');
      await expect(memberPage.getByRole('heading', { name: 'Export Compliance Report', exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(memberPage.getByText('View only').first()).toBeVisible({ timeout: 30_000 });
      await expect(memberPage.getByRole('button', { name: 'Save sign-off' })).toHaveCount(0);
      await expect(memberPage.getByLabel('Board meeting date')).not.toBeEditable();
    });

    await expect.poll(() => privilegedMutationRequests, {
      message: 'read-only MEMBER route traversal must not emit privileged API writes',
    }).toEqual([]);
  });

  test('a live admin demotion closes stale board editing and fails closed in place', async ({
    owner,
    newFencedContext,
  }) => {
    const admin = await createVerifiedAdmin({
      email: uniqueEmail('stale-admin'),
      name: 'Stale Admin',
      organisationId: owner.organisationId,
    });
    const storageState = await createAuthenticatedStorageState({
      userId: admin.userId,
      organisationId: admin.organisationId,
      role: admin.role,
    });
    const adminContext = await newFencedContext({ storageState });
    const adminPage = await adminContext.newPage();

    await gotoWithDevServerRetry(adminPage, '/board');
    await adminPage.getByRole('button', { name: 'Add trustee' }).click();
    await reliableFill(adminPage.getByLabel('Full name'), 'Forbidden trustee draft');
    await reliableFill(adminPage.getByLabel('Role'), 'Trustee');
    await reliableFill(adminPage.getByLabel('Date appointed'), '2026-02-01');

    const demotedRows = await withDb(async (client) => {
      // Keep the disposable session alive so the real auth guard re-resolves
      // the database role and the route's requireAdmin check returns its exact
      // 403/FORBIDDEN contract to the already-open stale Admin UI.
      const result = await client.query(
        `UPDATE "User"
            SET "role" = 'MEMBER', "updatedAt" = NOW()
          WHERE "id" = $1 AND "organisationId" = $2 AND "role" = 'ADMIN'`,
        [admin.userId, admin.organisationId],
      );
      return result.rowCount ?? 0;
    });
    expect(demotedRows).toBe(1);

    const forbiddenResponse = adminPage.waitForResponse(
      (response) => /\/api\/v1\/board-members$/.test(response.url()) && response.status() === 403,
    );
    await adminPage.getByRole('button', { name: 'Add trustee' }).last().click();
    await forbiddenResponse;

    await expect(adminPage).toHaveURL(/\/board$/);
    await expect(adminPage.getByRole('dialog')).toHaveCount(0);
    await expect(adminPage.getByText(/role no longer allows board register changes/i)).toBeVisible();
    await expect(adminPage.getByRole('button', { name: 'Add trustee' })).toHaveCount(0);
  });
});
