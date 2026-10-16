import { test, expect, reliableFill, uniqueEmail, TEST_PASSWORD } from '../fixtures';
import { createAuthenticatedStorageState, createVerifiedOwner, withDb } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';
import { IS_DEPLOYED_QA } from '../env';
import AxeBuilder from '@axe-core/playwright';

for (const outcome of ['recorded', 'lost-save', 'lost-withdrawal']) {
  const loseResponse = outcome === 'lost-save', loseWithdrawal = outcome === 'lost-withdrawal';
  test(`Owner records retained-copy review and reconciles receipts${outcome === 'recorded' ? '' : ` after ${outcome}`}`, async ({ newFencedContext, browserOriginFence }) => {
    test.skip(IS_DEPLOYED_QA, 'Synthetic fixture and response interception require the isolated disposable stack.');
    test.setTimeout(150_000);
    const stamp = Date.now();
    const owner = await createVerifiedOwner({ email: uniqueEmail('retained-copy-ui'), password: TEST_PASSWORD,
      name: 'Synthetic Copy Review Owner', organisationName: 'Isolated Copy Review Charity' });
    const documentId = `review-doc-${stamp}`, publicationId = `review-pub-${stamp}`;
    const cloudId = '00000000-0000-4000-8000-000000000001', pageId = `synthetic-page-${stamp}`;
    const revisions = await withDb(async client => {
      // Return the database's UTC revision text. node-postgres interprets a
      // timestamp-without-time-zone Date in the test host's local timezone.
      const document = await client.query<{ revision: string }>(
        `INSERT INTO "Document" (id,"organisationId",name,category,visibility,"lifecycleStatus","fileUrl","fileSize","mimeType","createdAt","updatedAt")
         VALUES ($1,$2,$3,'OTHER','RESTRICTED','RETIRED',$4,42,'text/plain',NOW(),NOW())
         RETURNING to_char("updatedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS revision`,
        [documentId, owner.organisationId, `Synthetic retained review ${stamp}`, `${owner.organisationId}/synthetic-${stamp}.txt`]);
      const publication = await client.query<{ revision: string }>(
        `INSERT INTO "DocumentPublication" (id,"organisationId","documentId",provider,"cloudId","spaceId","pageId","pageTitle",state,"retiredAt","nextAttemptAt","updatedAt")
         VALUES ($1,$2,$3,'confluence',$4,'synthetic-space',$5,$6,'RETIRED',NOW(),NULL,NOW())
         RETURNING to_char("updatedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS revision`,
        [publicationId, owner.organisationId, documentId, cloudId, pageId, `Synthetic retained review ${stamp}`]);
      return { document: document.rows[0].revision, publication: publication.rows[0].revision };
    });
    const context = await newFencedContext({ storageState: await createAuthenticatedStorageState({ ...owner, role: 'OWNER' }) });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 1600 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const root = `${browserOriginFence.apiOrigin}/api/v1/integrations/confluence/retained-copy-reviews`;
    // Only observation is intercepted: this proves the interface and actual
    // review persistence/receipt API, not source bytes or Atlassian inventory.
    await page.route(`${root}/observe/${publicationId}`, async route => {
      expect(route.request().method()).toBe('POST');
      await route.fulfill({ json: { data: {
      sourceBytesObserved: true, actionAuthorized: false, syntheticVerified: false, allCopiesVerified: false,
      snapshot: { organisationId: owner.organisationId, documentId, publicationId,
        sourceRevision: revisions.document, publicationRevision: revisions.publication,
        sourceSha256: 'a'.repeat(64), lifecycleStatus: 'RETIRED', deletionHold: false,
        externalPublicationApproved: false, publicationState: 'RETIRED', cloudId,
        siteOrigin: 'https://charitypilot-synthetic-test.atlassian.net', spaceId: 'synthetic-space', pageId,
        inventory: { observedAt: new Date().toISOString(), status: 'CURRENT', complete: true,
          currentPageVersion: 1, pageVersions: [1], attachments: [] } },
    } } });
    });
    let submissions = 0;
    let attemptedAt = '';
    await page.route(`${root}/`, async route => {
      expect(route.request().method()).toBe('POST');
      submissions++;
      attemptedAt = (route.request().postDataJSON() as { reviewedAt: string }).reviewedAt;
      const response = await route.fetch({ maxRedirects: 0 });
      expect(response.status(), await response.text()).toBe(201);
      if (loseResponse) await route.abort('failed');
      else await route.fulfill({ response });
    });
    await gotoWithDevServerRetry(page, '/integrations');
    const theme = loseResponse || loseWithdrawal ? 'dark' : 'light';
    await page.evaluate(theme => {
      localStorage.setItem('theme', theme);
      document.documentElement.classList.toggle('dark', theme === 'dark');
      window.dispatchEvent(new Event('themechange'));
    }, theme);
    await expect(page.getByRole('button', { name: 'Review erasure request', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Review retained synthetic copy', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Retained synthetic copy review' });
    await expect(panel.getByText(/No review receipts are listed/)).toBeVisible();
    await panel.getByRole('button', { name: 'Observe current source and copy', exact: true }).click();
    await expect(panel.getByText(`Observed source SHA-256: ${'a'.repeat(64)}`)).toBeVisible();
    for (const label of ['Review decision reference', 'Primary retention decision reference', 'Hold review reference',
      'Copy inventory evidence reference', 'Synthetic test evidence reference']) {
      await reliableFill(panel.getByLabel(label, { exact: true }), `UI-REVIEW-${stamp}`);
    }
    const submit = panel.getByRole('button', { name: 'Record synthetic copy review', exact: true });
    await expect(submit).toBeDisabled();
    await panel.getByRole('checkbox', { name: /I checked the receipts and evidence/ }).check();
    if (!loseResponse) {
      const scan = await new AxeBuilder({ page }).include('[aria-label="Retained synthetic copy review"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(scan.violations.filter(issue => issue.impact === 'serious' || issue.impact === 'critical')).toEqual([]);
      await panel.screenshot({ path: test.info().outputPath('review-panel.png') });
    }
    await submit.click();
    if (loseResponse) {
      await expect(panel.getByText(/The save outcome needs reconciliation/)).toBeVisible();
      await expect(panel.getByText(`Attempted review: UI-REVIEW-${stamp} · reviewer you · ${new Date(attemptedAt).toLocaleString('en-IE')}`)).toBeVisible();
      await expect(submit).toBeDisabled();
      await expect(panel.getByRole('button', { name: 'Observe current source and copy', exact: true })).toBeDisabled();
      await panel.getByRole('button', { name: 'Refresh review receipts', exact: true }).click();
    } else {
      await expect(panel.getByText(/Review recorded:/)).toBeVisible();
    }
    await expect(panel.locator('li').filter({ hasText: `UI-REVIEW-${stamp}` })).toHaveCount(1);
    if (loseResponse) {
      const scan = await new AxeBuilder({ page }).include('[aria-label="Retained synthetic copy review"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(scan.violations.filter(issue => issue.impact === 'serious' || issue.impact === 'critical')).toEqual([]);
      await panel.screenshot({ path: test.info().outputPath('review-uncertain-receipt.png') });
    }
    expect(submissions).toBe(1);
    const stored = await withDb(async client => {
      const reviews = await client.query(`SELECT "reviewerId","authorisesProviderIO",review FROM "ConfluenceRetainedCopyReview" WHERE "organisationId"=$1 AND "publicationId"=$2`,
        [owner.organisationId, publicationId]);
      const deletion = await client.query(`SELECT count(*)::integer AS count FROM "DocumentStorageDeletion" WHERE "organisationId"=$1`, [owner.organisationId]);
      return { reviews: reviews.rows, deletions: deletion.rows[0].count };
    });
    expect(stored.reviews).toHaveLength(1);
    expect(stored.reviews[0].reviewerId).toBe(owner.userId);
    expect(stored.reviews[0].authorisesProviderIO).toBe(false);
    expect(stored.reviews[0].review).toMatchObject({ scope: 'SYNTHETIC_ONLY', primaryDisposition: 'RETAIN', copyDisposition: 'PURGE' });
    expect(stored.deletions).toBe(0);
    if (!loseResponse) {
      await panel.getByRole('button', { name: 'Review synthetic permission', exact: true }).click();
      const permissionPanel = panel.getByRole('region', { name: 'Synthetic copy permission' });
      await expect(permissionPanel.getByText(/No permission receipt is listed/)).toBeVisible();
      for (const [label, value] of [
        ['Registered synthetic scope ID', `missing-scope-${stamp}`],
        ['Registered scope evidence reference', `SCOPE-${stamp}`],
        ['Disposal policy evidence reference', `POLICY-${stamp}`],
        ['Permission decision reference', `PERMISSION-${stamp}`],
        ['Permission expiry (UTC)', new Date(Date.now() + 5 * 60000).toISOString()],
        ['Permission reason', 'Synthetic permission must refuse because no maintenance scope is registered.'],
      ]) await reliableFill(permissionPanel.getByLabel(label, { exact: true }), value);
      const issue = permissionPanel.getByRole('button', { name: 'Record synthetic permission', exact: true });
      await expect(issue).toBeDisabled();
      await permissionPanel.getByRole('checkbox', { name: /I authorise purge of this exact synthetic/ }).check();
      const permissionScan = await new AxeBuilder({ page }).include('[aria-label="Synthetic copy permission"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(permissionScan.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')).toEqual([]);
      await permissionPanel.screenshot({ path: test.info().outputPath('synthetic-permission.png') });
      const refusedPermission = page.waitForResponse(response => response.url().endsWith('/permission') && response.request().method() === 'POST');
      await issue.click();
      const refused = await refusedPermission;
      expect(refused.status(), await refused.text()).toBe(409);
      expect((await refused.json()).code).toBe('CONFLUENCE_COPY_PERMISSION_REVIEW_REQUIRED');
      await expect(permissionPanel.getByText(/Permission outcome needs reconciliation/)).toBeVisible();
      await permissionPanel.getByRole('button', { name: 'Refresh permission receipt', exact: true }).click();
      await expect(permissionPanel.getByText(/No permission receipt is listed/)).toBeVisible();
      await expect(issue).toBeDisabled();
      const permissions = await withDb(async client => (await client.query(
        `SELECT count(*)::integer AS count FROM "ConfluenceRetainedCopyPermission" WHERE "organisationId"=$1`, [owner.organisationId])).rows[0].count);
      expect(permissions).toBe(0);
      const reviewId = await withDb(async client => (await client.query<{ id: string }>(
        `SELECT id FROM "ConfluenceRetainedCopyReview" WHERE "organisationId"=$1 AND "publicationId"=$2`,
        [owner.organisationId, publicationId])).rows[0].id);
      let withdrawals = 0;
      await page.route(`${root}/${reviewId}/withdraw`, async route => {
        expect(route.request().method()).toBe('POST');
        withdrawals++;
        const response = await route.fetch({ maxRedirects: 0 });
        expect(response.status(), await response.text()).toBe(201);
        if (loseWithdrawal) await route.abort('failed');
        else await route.fulfill({ response });
      });
      await expect(panel.getByRole('button', { name: 'Review withdrawal', exact: true })).toBeVisible();
      await panel.getByRole('button', { name: 'Review withdrawal', exact: true }).click();
      const withdrawal = panel.getByRole('group', { name: 'Withdraw this review' });
      await reliableFill(withdrawal.getByLabel('Withdrawal evidence reference', { exact: true }), `WITHDRAW-${stamp}`);
      await reliableFill(withdrawal.getByLabel('Withdrawal reason', { exact: true }), 'Synthetic review withdrawn after the recorded browser test.');
      const withdraw = withdrawal.getByRole('button', { name: 'Withdraw review', exact: true });
      await expect(withdraw).toBeDisabled();
      await withdrawal.getByRole('checkbox', { name: /I confirm withdrawal of this exact review/ }).check();
      const withdrawalScan = await new AxeBuilder({ page }).include('[aria-label="Withdraw this review"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(withdrawalScan.violations.filter(issue => issue.impact === 'serious' || issue.impact === 'critical')).toEqual([]);
      await withdrawal.screenshot({ path: test.info().outputPath('review-withdrawal.png') });
      await withdraw.click();
      if (loseWithdrawal) {
        await expect(withdrawal.getByText(/Withdrawal outcome needs reconciliation/)).toBeVisible();
        await expect(withdraw).toBeDisabled();
        await panel.getByRole('button', { name: 'Refresh review receipts', exact: true }).click();
      }
      await expect(panel.locator('li').filter({ hasText: `UI-REVIEW-${stamp}` })).toContainText('withdrawn');
      expect(withdrawals).toBe(1);
      const persisted = await withDb(async client => (await client.query(
        `SELECT "actorUserId","evidenceRef",reason FROM "ConfluenceRetainedCopyReviewWithdrawal" WHERE "reviewId"=$1 AND "organisationId"=$2`,
        [reviewId, owner.organisationId])).rows);
      expect(persisted).toEqual([{ actorUserId: owner.userId, evidenceRef: `WITHDRAW-${stamp}`,
        reason: 'Synthetic review withdrawn after the recorded browser test.' }]);
    }

  });
}
