import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { test, expect, reliableFill } from '../fixtures';
import { IS_DEPLOYED_QA } from '../env';
import { withDb } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

test('a draft enters Deleted Items and restores with identical bytes and retained audit', async ({ owner, ownerPage, browserOriginFence }) => {
  test.skip(IS_DEPLOYED_QA, 'Synthetic policy requires the runner-owned disposable database.');
  const name = `Recovery proof ${Date.now()}`;
  const policyId = `recovery-policy-${Date.now()}`;
  const sample = path.resolve(__dirname, '../fixtures/sample-document.txt');
  await withDb(client => client.query(`INSERT INTO "DataRetentionPolicyRevision"
    (id,"organisationId","recordClass",revision,state,"retentionMode","recoveryDays","createdById","approvedById","approvedAt","approvalEvidenceRef")
    VALUES ($1,$2,'VAULT_DRAFT',1,'APPROVED','REVIEW_REQUIRED',30,$3,$3,CURRENT_TIMESTAMP,'SYNTHETIC-POLICY-001')`,
  [policyId, owner.organisationId, owner.userId]));
  await gotoWithDevServerRetry(ownerPage, '/documents');
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
  const retained = await withDb(client => client.query(`SELECT "deletedAt","recoverySha256" FROM "Document" WHERE id=$1`, [id]));
  expect(retained.rows[0].deletedAt).toBeTruthy();
  expect(retained.rows[0].recoverySha256).toMatch(/^[a-f0-9]{64}$/);
  const jobs = await withDb(client => client.query(`SELECT id FROM "DocumentStorageDeletion" WHERE "sourceDocumentId"=$1`, [id]));
  expect(jobs.rowCount).toBe(0);
  // Owner ordinary detail/download are denied while the record is retained.
  for (const suffix of ['', '/download']) {
    const response = await ownerPage.request.get(`${browserOriginFence.apiOrigin}/api/v1/documents/${id}${suffix}`);
    expect(response.status()).toBe(404);
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
});
