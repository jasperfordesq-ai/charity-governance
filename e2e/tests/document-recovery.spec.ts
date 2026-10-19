import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { test, expect, reliableFill } from '../fixtures';
import { IS_DEPLOYED_QA } from '../env';
import { withDb } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

test('calendar-year retention keeps units separate and records exact approved terms', async ({ owner, ownerPage, browserOriginFence }) => {
  test.skip(IS_DEPLOYED_QA, 'Synthetic policy requires the runner-owned disposable database.');
  await gotoWithDevServerRetry(ownerPage, '/documents');
  const policies = ownerPage.getByRole('region', { name: 'Draft retention policies' });
  // A replacement approval puts its evidence reference on the withdrawn row
  // too. Keep prior history so broad text selectors fail deterministically.
  await reliableFill(policies.getByLabel('Recovery days after removal'), '30');
  await policies.getByRole('button', { name: 'Review approval' }).click();
  const baseline = ownerPage.getByRole('dialog', { name: 'Approve draft retention policy' });
  await reliableFill(baseline.getByLabel('Policy approval evidence reference'), 'SYNTHETIC-CALENDAR-BASELINE');
  await baseline.getByRole('checkbox', { name: /I have authority to approve these exact terms/ }).check();
  const baselineSaved = ownerPage.waitForResponse(response => response.url().endsWith('/documents/policy-revisions') && response.request().method() === 'POST');
  await baseline.getByRole('button', { name: 'Approve and replace earlier approvals' }).click();
  const baselineResponse = await baselineSaved;
  expect(baselineResponse.status()).toBe(201);
  const baselineId = (await baselineResponse.json()).data.id;
  await policies.getByLabel('Retention rule', { exact: true }).selectOption('AFTER_CALENDAR_YEARS');
  await expect(policies.getByLabel('Minimum retention calendar years')).toHaveValue('');
  await reliableFill(policies.getByLabel('Recovery days after removal'), '30');
  await reliableFill(policies.getByLabel('Minimum retention calendar years'), '0');
  await expect(policies.getByRole('button', { name: 'Review approval' })).toBeDisabled();
  await reliableFill(policies.getByLabel('Minimum retention calendar years'), '6');
  await policies.getByRole('button', { name: 'Review approval' }).click();
  const dialog = ownerPage.getByRole('dialog', { name: 'Approve draft retention policy' });
  await expect(dialog).toContainText('6 calendar years');
  await expect(dialog.getByRole('button', { name: 'Approve and replace earlier approvals' })).toBeDisabled();
  await reliableFill(dialog.getByLabel('Policy approval evidence reference'), 'SYNTHETIC-CALENDAR-001');
  await dialog.getByRole('checkbox', { name: /I have authority to approve these exact terms/ }).check();
  const saved = ownerPage.waitForResponse(response => response.url().endsWith('/documents/policy-revisions') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Approve and replace earlier approvals' }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const { id, revision } = (await response.json()).data;
  const state = await withDb(client => client.query(`SELECT "retentionMode","retentionDays","retentionYears","retentionAnchor",state,
    "approvalEvidenceRef" FROM "DataRetentionPolicyRevision" WHERE id=$1 AND "organisationId"=$2`, [id, owner.organisationId]));
  expect(state.rows).toEqual([{ retentionMode: 'AFTER_CALENDAR_YEARS', retentionDays: null, retentionYears: 6,
    retentionAnchor: 'CREATED_AT', state: 'APPROVED', approvalEvidenceRef: 'SYNTHETIC-CALENDAR-001' }]);
  const withdrawal = await withDb(client => client.query(`SELECT "evidenceRef" FROM "DataRetentionPolicyWithdrawal"
    WHERE "policyId"=$1 AND "organisationId"=$2`, [baselineId, owner.organisationId]));
  expect(withdrawal.rows).toEqual([{ evidenceRef: 'SYNTHETIC-CALENDAR-001' }]);
  await policies.getByRole('button', { name: 'Load policy history' }).click();
  const row = policies.getByRole('listitem').filter({ has: ownerPage.getByRole('heading', { name: `Revision ${revision}: Approved`, exact: true }) });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('Approval evidence: SYNTHETIC-CALENDAR-001', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Copy terms into form' }).click();
  await expect(policies.getByLabel('Minimum retention calendar years')).toHaveValue('6');
  await policies.getByLabel('Retention rule', { exact: true }).selectOption('AFTER_ANCHOR');
  await expect(policies.getByLabel('Minimum retention days')).toHaveValue('');
  await expect(policies.getByRole('button', { name: 'Review approval' })).toBeDisabled();
  await ownerPage.screenshot({ path: test.info().outputPath('calendar-units.png'), fullPage: false, animations: 'disabled' });
});

test('a draft enters Deleted Items and restores with identical bytes and retained audit', async ({ owner, ownerPage, browserOriginFence }) => {
  test.skip(IS_DEPLOYED_QA, 'Synthetic policy requires the runner-owned disposable database.');
  const name = `Recovery proof ${Date.now()}`;
  const sample = path.resolve(__dirname, '../fixtures/sample-document.txt');
  await gotoWithDevServerRetry(ownerPage, '/documents');
  const policies = ownerPage.getByRole('region', { name: 'Draft retention policies' });
  await expect(policies.getByLabel('Recovery days after removal')).toHaveValue('');
  await expect(policies.getByRole('button', { name: 'Review approval' })).toBeDisabled();
  // Prove the preset is read-only even when this tenant already has history.
  await reliableFill(policies.getByLabel('Recovery days after removal'), '45');
  const existingProposal = ownerPage.waitForResponse(response => response.url().endsWith('/documents/policy-revisions') && response.request().method() === 'POST');
  await policies.getByRole('button', { name: 'Save proposal' }).click();
  expect((await existingProposal).status()).toBe(201);
  await reliableFill(policies.getByLabel('Recovery days after removal'), '');
  const policyCount = async () => {
    const rows = await withDb(client => client.query('SELECT count(*) AS count FROM "DataRetentionPolicyRevision" WHERE "organisationId"=$1 AND "recordClass"=\'VAULT_DRAFT\'', [owner.organisationId]));
    return Number(rows.rows[0].count);
  };
  const beforePreset = await policyCount();
  expect(beforePreset).toBeGreaterThan(0);
  const policyWrites: string[] = [];
  ownerPage.on('request', request => {
    if (request.url().endsWith('/documents/policy-revisions') && request.method() === 'POST') policyWrites.push(request.url());
  });
  await policies.getByRole('button', { name: 'Use recommended draft settings' }).click();
  await expect(policies.getByLabel('Recovery days after removal')).toHaveValue('30');
  await expect(policies.getByLabel('Retention rule', { exact: true })).toHaveValue('REVIEW_REQUIRED');
  await expect(policies.getByRole('status')).toContainText('not saved or approved');
  expect(policyWrites).toHaveLength(0);
  expect(await policyCount()).toBe(beforePreset);
  const copyPolicies = ownerPage.getByRole('region', { name: 'Document copy retention policies' });
  await expect(copyPolicies.getByRole('button', { name: 'Use recommended draft settings' })).toHaveCount(0);
  await expect(copyPolicies.getByLabel('Recorded recovery period (days)')).toHaveValue('');
  const proposal = ownerPage.waitForResponse(response => response.url().endsWith('/documents/policy-revisions') && response.request().method() === 'POST');
  await policies.getByRole('button', { name: 'Save proposal' }).click();
  expect((await proposal).status()).toBe(201);
  const approve = async (evidence: string) => {
    await policies.getByRole('button', { name: 'Review approval' }).click();
    await reliableFill(ownerPage.getByLabel('Policy approval evidence reference'), evidence);
    await ownerPage.getByRole('checkbox', { name: /I have authority to approve these exact terms/ }).check();
    const response = ownerPage.waitForResponse(item => item.url().endsWith('/documents/policy-revisions') && item.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Approve and replace earlier approvals' }).click();
    const result = await response;
    expect(result.status()).toBe(201);
    return (await result.json()).data.id as string;
  };
  const policyId = await approve('SYNTHETIC-POLICY-001');
  await ownerPage.getByRole('button', { name: 'Upload Document' }).click();
  await reliableFill(ownerPage.getByLabel('Document Name'), name);
  await ownerPage.locator('#document-upload-file').setInputFiles(sample);
  const upload = ownerPage.waitForResponse(response => /\/api\/v1\/documents$/.test(response.url()) && response.request().method() === 'POST');
  await ownerPage.getByRole('button', { name: 'Upload', exact: true }).click();
  const uploadResponse = await upload;
  expect(uploadResponse.status()).toBe(201);
  const id = (await uploadResponse.json()).data.id as string;
  const row = ownerPage.getByRole('article').filter({ hasText: name });
  await row.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
  await ownerPage.getByLabel('Approved recovery policy').selectOption(policyId);
  await reliableFill(ownerPage.getByLabel('Removal authority reference'), 'SYNTHETIC-REMOVAL-001');
  await reliableFill(ownerPage.getByLabel('Reason for removing this draft'), 'Synthetic draft retained for this recovery rehearsal.');
  const removal = ownerPage.waitForResponse(response => response.url().endsWith(`/documents/${id}`) && response.request().method() === 'DELETE');
  await ownerPage.getByRole('button', { name: 'Move to Deleted Items', exact: true }).click();
  expect((await removal).status()).toBe(200);
  await expect(row).toHaveCount(0);
  const retained = await withDb(client => client.query(`SELECT "deletedAt","recoverySha256","recoveryUntil" FROM "Document" WHERE id=$1`, [id]));
  expect(retained.rows[0].deletedAt).toBeTruthy();
  expect(retained.rows[0].recoverySha256).toMatch(/^[a-f0-9]{64}$/);
  const jobs = await withDb(client => client.query(`SELECT id FROM "DocumentStorageDeletion" WHERE "sourceDocumentId"=$1`, [id]));
  expect(jobs.rowCount).toBe(0);
  await reliableFill(policies.getByLabel('Recovery days after removal'), '45');
  const replacementId = await approve('SYNTHETIC-POLICY-002');
  const withdrawal = await withDb(client => client.query(`SELECT "evidenceRef" FROM "DataRetentionPolicyWithdrawal" WHERE "policyId"=$1`, [policyId]));
  expect(withdrawal.rows[0].evidenceRef).toBe('SYNTHETIC-POLICY-002');
  const deadline = await withDb(client => client.query(`SELECT "recoveryUntil" FROM "Document" WHERE id=$1`, [id]));
  expect(deadline.rows[0].recoveryUntil).toEqual(retained.rows[0].recoveryUntil);
  // Owner ordinary detail/download are denied while the record is retained.
  for (const suffix of ['', '/download']) {
    const status = await ownerPage.evaluate(async url => (await fetch(url, { credentials: 'include' })).status,
      `${browserOriginFence.apiOrigin}/api/v1/documents/${id}${suffix}`);
    expect(status).toBe(404);
  }
  const panel = ownerPage.getByRole('region', { name: 'Deleted Items', exact: true });
  await panel.getByRole('button', { name: 'Load Deleted Items' }).click();
  await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Review restoration' }).click();
  await reliableFill(ownerPage.getByLabel('Reason for restoration'), 'Restore the synthetic draft and verify the original bytes.');
  await ownerPage.screenshot({ path: test.info().outputPath('restore-dialog.png'), fullPage: false, animations: 'disabled' });
  const restored = ownerPage.waitForResponse(response => response.url().endsWith(`/documents/${id}/restore`) && response.request().method() === 'POST');
  await ownerPage.getByRole('button', { name: 'Restore with restricted access' }).click();
  expect((await restored).status()).toBe(200);
  await expect(row).toBeVisible();
  const download = ownerPage.waitForEvent('download');
  await row.getByRole('button', { name: `Download ${name}`, exact: true }).click();
  const downloaded = await download;
  expect(await readFile((await downloaded.path())!)).toEqual(await readFile(sample));
  const state = await withDb(client => client.query(`SELECT "deletedAt",visibility,"externalPublicationApproved" FROM "Document" WHERE id=$1`, [id]));
  expect(state.rows[0]).toEqual({ deletedAt: null, visibility: 'RESTRICTED', externalPublicationApproved: false });
  const audit = await withDb(client => client.query(`SELECT kind FROM "DocumentControlAudit" WHERE "documentId"=$1 AND kind IN ('RECORD_REMOVE','RECORD_RESTORE') ORDER BY "occurredAt"`, [id]));
  expect(audit.rows.map(row => row.kind)).toEqual(['RECORD_REMOVE', 'RECORD_RESTORE']);
  await policies.getByRole('button', { name: 'Load policy history' }).click();
  const current = policies.getByRole('listitem').filter({ has: ownerPage.getByText('Approval evidence: SYNTHETIC-POLICY-002', { exact: true }) });
  await current.getByRole('button', { name: 'Review withdrawal' }).click();
  await reliableFill(ownerPage.getByLabel('Withdrawal evidence reference'), 'SYNTHETIC-WITHDRAW-001');
  await reliableFill(ownerPage.getByLabel('Reason for policy withdrawal'), 'Withdraw the policy after this synthetic recovery rehearsal.');
  const withdrawn = ownerPage.waitForResponse(response => response.url().endsWith(`/policy-revisions/${replacementId}/withdraw`) && response.request().method() === 'POST');
  await ownerPage.getByRole('button', { name: 'Withdraw policy', exact: true }).click();
  expect((await withdrawn).status()).toBe(201);
});
