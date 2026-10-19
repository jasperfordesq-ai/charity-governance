import path from 'node:path';
import { test, expect, reliableFill, uniqueEmail, TEST_PASSWORD } from '../fixtures';
import { createAuthenticatedStorageState, createVerifiedOwner, withDb } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';
import { IS_DEPLOYED_QA } from '../env';

// Real browser -> application routes/services -> disposable PostgreSQL. Only
// Atlassian is simulated by the existing private fake service. No permission
// response or server-side source observation is replaced by this spec.
for (const lostAcknowledgement of [false, true]) {
  test(`Owner issues and withdraws exact synthetic copy permission${lostAcknowledgement ? ' after lost acknowledgements' : ''}`, async ({ newFencedContext, browserOriginFence }) => {
    test.skip(IS_DEPLOYED_QA, 'Synthetic scope registration requires the runner-owned disposable database.');
    test.setTimeout(180_000);
    const stamp = Date.now();
    const owner = await createVerifiedOwner({ email: uniqueEmail('copy-permission'), password: TEST_PASSWORD,
      name: 'Synthetic Permission Owner', organisationName: 'Isolated Permission Charity' });
    const context = await newFencedContext({ storageState: await createAuthenticatedStorageState({ ...owner, role: 'OWNER' }) });
    const page = await context.newPage();
    await gotoWithDevServerRetry(page, '/integrations');
    await page.getByRole('button', { name: 'Connect Confluence', exact: true }).click();
    const consent = page.getByRole('button', { name: /continue to Atlassian/i });
    await expect(consent).toBeVisible();
    const state = new URL((await consent.getAttribute('href'))!).searchParams.get('state');
    expect(state).toBeTruthy();
    const callback = page.waitForResponse(r => r.url().endsWith('/confluence/callback') && r.request().method() === 'POST');
    await gotoWithDevServerRetry(page, `/integrations/confluence/callback?code=fake-authorization-code&state=${encodeURIComponent(state!)}`);
    expect((await callback).status()).toBe(200);

    await gotoWithDevServerRetry(page, '/documents');
    await page.getByRole('button', { name: /Upload document/i }).click();
    await reliableFill(page.getByLabel('Document name'), `Synthetic permission source ${stamp}`);
    await page.locator('#document-upload-file').setInputFiles(path.resolve(__dirname, '../fixtures/sample-document.txt'));
    const upload = page.waitForResponse(r => r.url().endsWith('/api/v1/documents') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    const uploaded = await upload;
    expect(uploaded.status(), await uploaded.text()).toBe(201);
    const documentId = (await uploaded.json()).data.id as string;
    const publicationId = `permission-pub-${stamp}`;
    // Arrange a retained local source and an already-existing remote copy.
    // withDb independently verifies the runner's disposable database identity.
    await withDb(async client => {
      await client.query(`UPDATE "Document" SET "lifecycleStatus"='RETIRED' WHERE id=$1 AND "organisationId"=$2`, [documentId, owner.organisationId]);
      await client.query(`INSERT INTO "DocumentPublication" (id,"organisationId","documentId",provider,"cloudId","spaceId","pageId","pageTitle",state,"retiredAt","nextAttemptAt","updatedAt")
        VALUES ($1,$2,$3,'confluence','00000000-0000-4000-8000-000000000001','space-gov','synthetic-retained-copy','Synthetic retained copy','RETIRED',NOW(),NULL,NOW())`,
      [publicationId, owner.organisationId, documentId]);
    });
    await gotoWithDevServerRetry(page, '/integrations');
    await page.getByRole('button', { name: 'Review retained synthetic copy', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Retained synthetic copy review' });
    const observation = page.waitForResponse(r => r.url().endsWith(`/observe/${publicationId}`));
    await panel.getByRole('button', { name: 'Observe current source and copy', exact: true }).click();
    const observed = await observation;
    expect(observed.status(), await observed.text()).toBe(200);
    expect((await observed.json()).data).toMatchObject({ sourceBytesObserved: true, syntheticVerified: false, allCopiesVerified: false, actionAuthorized: false });
    for (const label of ['Review decision reference', 'Primary retention decision reference', 'Hold review reference',
      'Copy inventory evidence reference', 'Synthetic test evidence reference']) {
      await reliableFill(panel.getByLabel(label, { exact: true }), `REVIEW-${stamp}`);
    }
    await panel.getByRole('checkbox', { name: /I checked the receipts and evidence/ }).check();
    await panel.getByRole('button', { name: 'Record synthetic copy review', exact: true }).click();
    await expect(panel.getByText(/Review recorded:/)).toBeVisible();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const scopeId = `scope-${stamp}`;
    const review = await withDb(async client => {
      const row = (await client.query<{ id: string; snapshotSha256: string }>(`SELECT id,"snapshotSha256" FROM "ConfluenceRetainedCopyReview" WHERE "organisationId"=$1 AND "publicationId"=$2`, [owner.organisationId, publicationId])).rows[0];
      // Maintenance registration, never a browser or application-role capability.
      // The real SQL trigger validates Owner, current review, digest and expiry.
      await client.query(`INSERT INTO "ConfluenceSyntheticCopyScope" (id,"organisationId","reviewId","snapshotSha256","evidenceRef","disposalPolicyEvidenceRef","approvedById","expiresAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [scopeId, owner.organisationId, row.id, row.snapshotSha256, `SCOPE-${stamp}`, `POLICY-${stamp}`, owner.userId, expiresAt]);
      return row;
    });
    const root = `${browserOriginFence.apiOrigin}/api/v1/integrations/confluence/retained-copy-reviews`;
    let issues = 0, withdrawals = 0;
    await page.route(`${root}/${review.id}/permission`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      issues++;
      const response = await route.fetch({ maxRedirects: 0 });
      expect(response.status(), await response.text()).toBe(201);
      expect((await response.json()).data.providerIOAuthorised).toBe(false);
      if (lostAcknowledgement) await route.abort('failed');
      else await route.fulfill({ response });
    });
    await panel.getByRole('button', { name: 'Review synthetic permission', exact: true }).click();
    const permissionPanel = panel.getByRole('region', { name: 'Synthetic copy permission' });
    await expect(permissionPanel.getByText(/No permission receipt is listed/)).toBeVisible();
    for (const [label, value] of [
      ['Registered synthetic scope ID', scopeId], ['Registered scope evidence reference', `SCOPE-${stamp}`],
      ['Disposal policy evidence reference', `POLICY-${stamp}`], ['Permission decision reference', `PERMISSION-${stamp}`],
      ['Permission expiry (UTC)', expiresAt], ['Permission reason', 'Authorise only the exact synthetic copy; retain the local record.'],
    ]) await reliableFill(permissionPanel.getByLabel(label, { exact: true }), value);
    const issue = permissionPanel.getByRole('button', { name: 'Record synthetic permission', exact: true });
    await expect(issue).toBeDisabled();
    await permissionPanel.getByRole('checkbox', { name: /I authorise purge of this exact synthetic/ }).check();
    await issue.click();
    if (lostAcknowledgement) {
      await expect(permissionPanel.getByText(/Permission outcome needs reconciliation/)).toBeVisible();
      await expect(issue).toBeDisabled();
      await permissionPanel.getByRole('button', { name: 'Refresh permission receipt', exact: true }).click();
    }
    await expect(permissionPanel.getByText(/Recorded permission:/)).toBeVisible();
    const permission = await withDb(async client => (await client.query(`SELECT id,"actorUserId","scopeId","snapshotSha256" FROM "ConfluenceRetainedCopyPermission" WHERE "reviewId"=$1 AND "organisationId"=$2`, [review.id, owner.organisationId])).rows);
    expect(permission).toHaveLength(1);
    expect(permission[0]).toMatchObject({ actorUserId: owner.userId, scopeId, snapshotSha256: review.snapshotSha256 });
    await page.route(`${root}/permissions/${permission[0].id}/withdraw`, async route => {
      withdrawals++;
      const response = await route.fetch({ maxRedirects: 0 });
      expect(response.status(), await response.text()).toBe(201);
      if (lostAcknowledgement) await route.abort('failed');
      else await route.fulfill({ response });
    });
    await permissionPanel.getByRole('button', { name: 'Review permission withdrawal', exact: true }).click();
    const withdrawal = permissionPanel.getByRole('group', { name: 'Withdraw this permission' });
    await reliableFill(withdrawal.getByLabel('Withdrawal evidence reference'), `WITHDRAW-${stamp}`);
    await reliableFill(withdrawal.getByLabel('Withdrawal reason'), 'Withdraw this synthetic permission after the browser journey.');
    const withdraw = withdrawal.getByRole('button', { name: 'Withdraw permission', exact: true });
    await expect(withdraw).toBeDisabled();
    await withdrawal.getByRole('checkbox', { name: /I confirm withdrawal of this exact permission/ }).check();
    await withdraw.click();
    if (lostAcknowledgement) {
      await expect(withdrawal.getByText(/Withdrawal outcome needs reconciliation/)).toBeVisible();
      await expect(withdraw).toBeDisabled();
      await permissionPanel.getByRole('button', { name: 'Refresh permission receipt', exact: true }).click();
    }
    await expect(permissionPanel.getByText(/permission withdrawn/)).toBeVisible();
    expect({ issues, withdrawals }).toEqual({ issues: 1, withdrawals: 1 });
    const persisted = await withDb(async client => ({
      withdrawals: (await client.query(`SELECT "actorUserId","evidenceRef" FROM "ConfluenceRetainedCopyPermissionWithdrawal" WHERE "permissionId"=$1 AND "organisationId"=$2`, [permission[0].id, owner.organisationId])).rows,
      deletions: (await client.query(`SELECT count(*)::integer AS count FROM "DocumentStorageDeletion" WHERE "organisationId"=$1`, [owner.organisationId])).rows[0].count,
    }));
    expect(persisted).toEqual({ withdrawals: [{ actorUserId: owner.userId, evidenceRef: `WITHDRAW-${stamp}` }], deletions: 0 });
  });
}
