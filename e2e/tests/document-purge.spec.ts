import { reviewCopyPolicy } from '../helpers/copy-policy';
import { reviewCopyPreservation } from '../helpers/copy-preservation';
import path from 'node:path';
import { test, expect, reliableFill } from '../fixtures';
import { IS_DEPLOYED_QA } from '../env';
import { withDb } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';
import { approveSyntheticDraftRecoveryPolicy } from '../helpers/draft-recovery-policy';

test('Owner reviews, cancels and executes primary disposal with retained history', async ({ owner, ownerPage, browserOriginFence }) => {
  test.skip(IS_DEPLOYED_QA, 'Expiry fixture is permitted only in the runner-owned disposable database.');
  test.setTimeout(180_000);
  ownerPage.on('pageerror', error => console.error('Purge browser exception:', error.stack));
  await gotoWithDevServerRetry(ownerPage, '/documents');
  const policyId = await approveSyntheticDraftRecoveryPolicy(ownerPage);
  const name = `Synthetic purge ${Date.now()}`;
  await ownerPage.getByRole('button', { name: 'Upload Document' }).click();
  await reliableFill(ownerPage.getByLabel('Document Name'), name);
  await ownerPage.locator('#document-upload-file').setInputFiles(path.resolve(__dirname, '../fixtures/sample-document.txt'));
  const uploaded = ownerPage.waitForResponse(response => /\/api\/v1\/documents$/.test(response.url()) && response.request().method() === 'POST');
  await ownerPage.getByRole('button', { name: 'Upload', exact: true }).click();
  const upload = await uploaded; expect(upload.status()).toBe(201);
  const id = (await upload.json()).data.id as string;
  await ownerPage.getByRole('article').filter({ hasText: name }).getByRole('button', { name: `Delete ${name}`, exact: true }).click();
  await ownerPage.getByLabel('Approved recovery policy').selectOption(policyId);
  await reliableFill(ownerPage.getByLabel('Removal authority reference'), 'SYNTHETIC-REMOVE-001');
  await reliableFill(ownerPage.getByLabel('Reason for removing this draft'), 'Synthetic draft removed for isolated purge verification.');
  const removed = ownerPage.waitForResponse(response => response.url().endsWith(`/documents/${id}`) && response.request().method() === 'DELETE');
  await ownerPage.getByRole('button', { name: 'Move to Deleted Items', exact: true }).click();
  expect((await removed).status()).toBe(200);
  const deleted = ownerPage.getByRole('region', { name: 'Deleted Items', exact: true });
  const decisions = ownerPage.getByRole('region', { name: 'Disposal decisions', exact: true });
  await deleted.getByRole('button', { name: 'Load Deleted Items', exact: true }).click();
  const retained = deleted.getByRole('listitem').filter({ has: ownerPage.getByRole('heading', { name, exact: true }) });
  await retained.getByRole('button', { name: 'Review disposal plan' }).click();
  const areas = ['Primary file','Provider versions','Confluence copies','Recipient exports','Audit records','Backups'];
  const authorize = async (evidence: string) => {
    const loaded = ownerPage.waitForResponse(response => response.url().endsWith('/documents/recovery-policies') && response.request().method() === 'GET');
    await decisions.getByRole('button', { name: 'Load disposal decisions' }).click(); await loaded;
    await decisions.getByLabel('Disposal policy', { exact: true }).selectOption(policyId);
    for (const [index, area] of areas.entries()) {
      await decisions.getByLabel(`${area} plan`, { exact: true }).selectOption(index === 0 ? 'DISPOSE' : 'RETAIN_APPROVED');
      await reliableFill(decisions.getByLabel(`${area} evidence reference`, { exact: true }), `SYNTHETIC-STORE-${index}`);
    }
    await reliableFill(decisions.getByLabel('Disposal authorization evidence reference'), evidence);
    await reliableFill(decisions.getByLabel('Reason for disposal authorization'), 'Synthetic primary disposal with other stores retained for review.');
    await decisions.getByRole('button', { name: 'Review disposal authorization' }).click();
    await ownerPage.getByRole('checkbox', { name: 'I have authority to approve this exact disposal plan and its evidence.' }).check();
    const saved = ownerPage.waitForResponse(response => response.url().endsWith('/documents/purge-authorizations') && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Record disposal authorization', exact: true }).click();
    const result = await saved; expect(result.status()).toBe(201);
    await expect(decisions.getByText(`Decision ${evidence}`, { exact: true })).toBeVisible();
    return (await result.json()).data.id as string;
  };
  const firstEvidence = 'SYNTHETIC-DISPOSAL-001';
  const firstId = await authorize(firstEvidence);
  const decision = (evidence: string) => decisions.getByRole('listitem').filter({ has: ownerPage.getByText(`Decision ${evidence}`, { exact: true }) });
  const claim = async (evidence: string, authId: string, expected: number) => {
    await decision(evidence).getByRole('button', { name: 'Review permanent primary disposal' }).click();
    await ownerPage.getByRole('checkbox', { name: 'I confirm permanent disposal of the primary file under this authorization.' }).check();
    const claimed = ownerPage.waitForResponse(response => response.url().endsWith(`/purge-authorizations/${authId}/claim`) && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Queue permanent primary disposal', exact: true }).click();
    const result = await claimed; expect(result.status()).toBe(expected); return result;
  };
  await claim(firstEvidence, firstId, 409);
  await ownerPage.getByRole('button', { name: 'Cancel', exact: true }).click();
  await decision(firstEvidence).getByRole('button', { name: 'Review disposal cancellation' }).click();
  await reliableFill(ownerPage.getByLabel('Disposal cancellation evidence reference'), 'SYNTHETIC-CANCEL-001');
  await reliableFill(ownerPage.getByLabel('Reason for disposal cancellation'), 'Withdraw the unexpired synthetic authorization before a new review.');
  const cancelled = ownerPage.waitForResponse(response => response.url().endsWith(`/purge-authorizations/${firstId}/withdraw`) && response.request().method() === 'POST');
  await ownerPage.getByRole('button', { name: 'Withdraw disposal authorization', exact: true }).click();
  expect((await cancelled).status()).toBe(200);
  await expect(decision(firstEvidence).getByText('Withdrawn: SYNTHETIC-CANCEL-001')).toBeVisible();
  // Only the verified disposable fixture ages time; runtime has no clock bypass.
  await withDb(async client => {
    await client.query('BEGIN');
    try {
      await client.query('ALTER TABLE "Document" DISABLE TRIGGER "Document_recovery_state_guard"');
      await client.query(`UPDATE "Document" SET "deletedAt"="deletedAt"-INTERVAL '31 days',"recoveryUntil"="recoveryUntil"-INTERVAL '31 days' WHERE id=$1 AND "organisationId"=$2`, [id, owner.organisationId]);
      await client.query('ALTER TABLE "Document" ENABLE TRIGGER "Document_recovery_state_guard"');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
  await deleted.getByRole('button', { name: 'Refresh Deleted Items', exact: true }).click();
  await retained.getByRole('button', { name: 'Review disposal plan' }).click();
  const secondEvidence = 'SYNTHETIC-DISPOSAL-002';
  const secondId = await authorize(secondEvidence);
  const result = await claim(secondEvidence, secondId, 200);
  const deletionId = (await result.json()).data.deletionId as string;
  await expect(retained).toHaveCount(0);
  const retry = await ownerPage.evaluate(async url => {
    const response = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmPermanentPurge: true }) });
    return { status: response.status, body: await response.json() };
  }, `${browserOriginFence.apiOrigin}/api/v1/documents/purge-authorizations/${secondId}/claim`);
  expect(retry.status).toBe(200); expect(retry.body.data.deletionId).toBe(deletionId);
  // This stack deliberately has no cleanup worker. Verify the durable handoff,
  // not physical erasure; a separate worker integration test must establish that.
  const job = await withDb(client => client.query(`SELECT state,"activeObjectAbsentAt" FROM "DocumentStorageDeletion" WHERE id=$1 AND "sourceDocumentId"=$2`, [deletionId, id]));
  expect(job.rows[0]).toEqual({ state: 'PENDING', activeObjectAbsentAt: null });
  const claims = await withDb(client => client.query(`SELECT count(*)::int AS count FROM "DocumentPurgeClaim" WHERE "documentId"=$1`, [id]));
  expect(claims.rows[0].count).toBe(1);
  await gotoWithDevServerRetry(ownerPage, '/documents');
  await decisions.getByRole('button', { name: 'Load disposal decisions' }).click();
  await expect(decision(secondEvidence).getByText('Primary disposal job: PENDING. Other copies remain separately accountable.')).toBeVisible();
  const copies = decision(secondEvidence).getByRole('region', { name: 'Copy and backup evidence' });
  await copies.getByRole('button', { name: 'Load copy evidence', exact: true }).click();
  await expect(copies.getByText('No downstream observations recorded.')).toBeVisible();
  await copies.getByLabel('Evidence storage location', { exact: true }).selectOption('BACKUPS');
  await reliableFill(copies.getByLabel('Copy or inventory scope reference', { exact: true }), 'SYNTHETIC-BACKUP-SET-001');
  await copies.getByLabel('Reviewed copy outcome', { exact: true }).selectOption('RETAINED_APPROVED');
  // This plan retains backups; absence may not be asserted through its form.
  await expect(copies.getByLabel('Reviewed copy outcome').locator('option[value="VERIFIED_ABSENT"]')).toHaveCount(0);
  const fillObservation = async (evidence: string) => {
    await reliableFill(copies.getByLabel('Copy observation evidence reference', { exact: true }), evidence);
    await reliableFill(copies.getByLabel('Reason for copy observation', { exact: true }), 'Synthetic review of the exact backup inventory and its custody evidence.');
    // Observe the verified database clock, not a potentially skewed host clock.
    // Text retains UTC explicitly: node-pg otherwise parses timestamp-without-zone
    // in the Windows host zone. Preserve milliseconds at the claim boundary.
    const clock = await withDb(client => client.query(`SELECT to_char(timezone('UTC',clock_timestamp()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`));
    const dates = await ownerPage.evaluate((serverTime: string) => {
      const local = (date: Date) => {
        // Chromium normalises .800 to .8 (and zero seconds away). Playwright
        // rejects a fill whose value changes, even when the instant is valid.
        const input = document.createElement('input');
        input.type = 'datetime-local';
        input.step = '0.001';
        input.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
        if (new Date(input.value).getTime() !== date.getTime()) throw new Error('Observation precision was lost');
        return input.value;
      };
      return { observed: local(new Date(serverTime)), followup: local(new Date(new Date(serverTime).getTime() + 86400000)) };
    }, clock.rows[0].now);
    await copies.getByLabel('Copy observation time', { exact: true }).fill(dates.observed);
    await copies.getByLabel('Copy follow-up time', { exact: true }).fill(dates.followup);
    await copies.getByRole('checkbox', { name: 'I reviewed the evidence for this exact scope and outcome.' }).check();
    const saved = ownerPage.waitForResponse(response => response.url().endsWith(`/purge-authorizations/${secondId}/dispositions`) && response.request().method() === 'POST');
    await copies.getByRole('button', { name: 'Record copy observation', exact: true }).click();
    const response = await saved;
    if (response.status() !== 200) {
      const timing = await withDb(client => client.query(`SELECT to_char("claimedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "claimedAt", to_char(timezone('UTC',clock_timestamp()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "databaseNow" FROM "DocumentPurgeClaim" WHERE "authorizationId"=$1`, [secondId]));
      console.error('Synthetic observation timing:', JSON.stringify({ input: response.request().postDataJSON().observedAt, clocks: timing.rows, response: await response.json() }));
    }
    expect(response.status()).toBe(200);
  };
  await fillObservation('SYNTHETIC-BACKUP-RECEIPT-001');
  const observation = (ref: string) => copies.getByRole('listitem').filter({ hasText: ref });
  await expect(observation('SYNTHETIC-BACKUP-RECEIPT-001')).toContainText('Retained with approved authority');
  await observation('SYNTHETIC-BACKUP-RECEIPT-001').getByRole('button', { name: 'Record a later observation' }).click();
  await expect(copies.getByLabel('Copy or inventory scope reference')).toBeDisabled();
  await reviewCopyPreservation(copies);
  await copies.getByLabel('Reviewed copy outcome', { exact: true }).selectOption('NEEDS_REVIEW');
  await fillObservation('SYNTHETIC-BACKUP-REOPEN-002');
  await expect(observation('SYNTHETIC-BACKUP-REOPEN-002')).toContainText('Revision 2');
  await expect(observation('SYNTHETIC-BACKUP-RECEIPT-001')).toContainText('Revision 1');
  const savedEvents = await withDb(client => client.query(`SELECT revision,status FROM "DocumentPurgeDispositionEvent" WHERE "authorizationId"=$1 ORDER BY revision`, [secondId]));
  expect(savedEvents.rows).toEqual([{ revision: 1, status: 'RETAINED_APPROVED' }, { revision: 2, status: 'NEEDS_REVIEW' }]);
  const stillPending = await withDb(client => client.query(`SELECT state,"activeObjectAbsentAt" FROM "DocumentStorageDeletion" WHERE id=$1`, [deletionId]));
  expect(stillPending.rows[0]).toEqual({ state: 'PENDING', activeObjectAbsentAt: null });
  await gotoWithDevServerRetry(ownerPage, '/documents');
  await decisions.getByRole('button', { name: 'Load disposal decisions' }).click();
  await copies.getByRole('button', { name: 'Load copy evidence', exact: true }).click();
  await expect(observation('SYNTHETIC-BACKUP-REOPEN-002')).toContainText('Needs review');
  await copies.scrollIntoViewIfNeeded();
  await ownerPage.screenshot({ path: test.info().outputPath('purge-history.png'), fullPage: false, animations: 'disabled' });
  await reviewCopyPolicy(ownerPage, 'Document');
});
