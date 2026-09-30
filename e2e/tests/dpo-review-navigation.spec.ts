import path from 'node:path';
import assert from 'node:assert/strict';
import { test, expect, reliableFill, uniqueEmail } from '../fixtures';
import { IS_DEPLOYED_QA } from '../env';
import { createAuthenticatedStorageState, createVerifiedMember, withDb } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';
import { approveSyntheticDraftRecoveryPolicy } from '../helpers/draft-recovery-policy';

const SAMPLE_FILE = path.resolve(__dirname, '../fixtures/sample-document.txt');

test.describe('DPO review navigation', () => {
  test.skip(IS_DEPLOYED_QA, 'Review fixtures require the identity-bound disposable database.');

  test('an Owner can page older detailed compliance decisions for one reporting year', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    await withDb((client) => client.query(
      `INSERT INTO "ComplianceAuditEvent"
        ("id", "organisationId", "reportingYear", "type", "standardId", "actorUserId",
         "beforeState", "afterState", "occurredAt")
       SELECT 'dpo-compliance-change-' || $2::text || '-' || lpad(n::text, 3, '0'),
         $1, 2026, 'RECORD_UPDATED', 'synthetic-standard', 'synthetic-admin',
         '{"status":"NOT_STARTED"}'::jsonb, '{"status":"COMPLIANT"}'::jsonb,
         '2026-09-29T10:00:00Z'::timestamptz
       FROM generate_series(1, 52) AS n`,
      [owner.organisationId, stamp],
    ));

    await gotoWithDevServerRetry(ownerPage, '/compliance');
    const history = ownerPage.locator('[aria-label="Detailed compliance decision history"]');
    await history.getByRole('button', { name: 'Load detailed decisions' }).click();
    await expect(history.locator('ol > li')).toHaveCount(50);
    await history.getByRole('button', { name: 'Load older compliance decisions' }).click();
    await expect(history.locator('ol > li')).toHaveCount(52);
    await expect(history.getByRole('button', { name: 'Load older compliance decisions' })).toHaveCount(0);
    await history.locator('ol > li').last().getByText('Inspect retained before and after record').click();
    await expect(history.locator('ol > li').last().getByText('COMPLIANT')).toBeVisible();
  });

  test('an Owner sees stale control claims and pages every detailed risk change', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    const riskId = `dpo-risk-${stamp}`;
    const riskTitle = `DPO synthetic C1 risk ${stamp}`;
    await withDb(async (client) => {
      await client.query(
        `UPDATE "Subscription" SET "plan" = 'COMPLETE', "updatedAt" = CURRENT_TIMESTAMP
         WHERE "organisationId" = $1`,
        [owner.organisationId],
      );
      await client.query(
        `INSERT INTO "RiskRecord"
          ("id", "organisationId", "title", "category", "description", "likelihood", "impact", "mitigation", "revision", "updatedAt")
         VALUES ($1, $2, $3, 'DATA_PROTECTION', 'Synthetic privacy review risk', 2, 2,
           'Review evidence before claiming closure', 1, CURRENT_TIMESTAMP)`,
        [riskId, owner.organisationId, riskTitle],
      );
      await client.query(
        `INSERT INTO "RiskChangeAudit"
          ("id", "organisationId", "riskId", "actorUserId", "action", "beforeState", "afterState", "occurredAt")
         SELECT 'dpo-risk-change-' || $2::text || '-' || lpad(n::text, 3, '0'), $1, $3,
           'synthetic-admin', 'UPDATE', '{"revision":1}'::jsonb, '{"revision":2}'::jsonb,
           '2026-09-29T10:00:00Z'::timestamptz
         FROM generate_series(1, 52) AS n`,
        [owner.organisationId, stamp, riskId],
      );
      await client.query(
        `INSERT INTO "RiskControlVerification"
          ("id", "organisationId", "riskId", "actorUserId", "controlReference", "state",
           "verifiedAt", "riskRevision", "evidenceReference", "reason")
         VALUES ($1, $2, $3, 'synthetic-admin', 'C1', 'VERIFIED',
           '2026-09-28T10:00:00Z'::timestamptz, 1, 'synthetic-C1-evidence',
           'Synthetic verification before the risk changed')`,
        [`dpo-claim-${stamp}`, owner.organisationId, riskId],
      );
      await client.query(
        `UPDATE "RiskRecord" SET "revision" = 2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [riskId],
      );
    });

    await gotoWithDevServerRetry(ownerPage, '/registers');
    const panel = ownerPage.getByRole('region', { name: 'Risk and control evidence' });
    await expect(panel.getByText(`${riskTitle} · C1 · record changed after revision 1`)).toBeVisible();
    await panel.getByRole('button', { name: 'Load history', exact: true }).click();
    await expect(panel.getByText('Showing 50 retained changes.')).toBeVisible();
    await panel.getByRole('button', { name: 'Load older risk changes' }).click();
    await expect(panel.getByText('Showing 52 retained changes.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Load older risk changes' })).toHaveCount(0);

    const riskHistoryButton = panel.getByRole('button', { name: 'Load this risk’s history' });
    await expect(async () => {
      if (await riskHistoryButton.isEnabled()) return;
      await ownerPage.keyboard.press('Escape');
      const trigger = panel.getByRole('button', { name: 'Risk', exact: true });
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      const option = ownerPage.getByRole('option', { name: riskTitle, exact: true });
      await expect(option).toBeVisible({ timeout: 5_000 });
      await option.click({ timeout: 5_000 });
      await expect(riskHistoryButton).toBeEnabled({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await riskHistoryButton.click();
    await expect(panel.getByText(`Showing 1 retained claim for ${riskTitle}.`)).toBeVisible();
    await expect(panel.locator('[aria-label="Selected risk control history"]')
      .getByText('Synthetic verification before the risk changed')).toBeVisible();
  });

  test('an Owner can page older sensitive register changes without exposing their values', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    await withDb(async (client) => {
      await client.query(
        `UPDATE "Subscription" SET "plan" = 'COMPLETE', "updatedAt" = CURRENT_TIMESTAMP
         WHERE "organisationId" = $1`, [owner.organisationId],
      );
      await client.query(
        `INSERT INTO "GovernanceRegisterChangeAudit"
          ("id", "organisationId", "recordKind", "recordId", "actorUserId", "action",
           "previousStatus", "nextStatus", "changedFields", "occurredAt")
         SELECT 'dpo-register-change-' || $2::text || '-' || lpad(n::text, 3, '0'),
           $1, 'COMPLAINT', 'synthetic-complaint', 'synthetic-admin', 'UPDATE',
           'OPEN', 'CLOSED', ARRAY['status']::text[], '2026-09-29T10:00:00Z'::timestamptz
         FROM generate_series(1, 52) AS n`,
        [owner.organisationId, stamp],
      );
    });

    await gotoWithDevServerRetry(ownerPage, '/registers');
    const history = ownerPage.locator('[aria-label="Register change history"]');
    await history.getByRole('button', { name: 'Load register changes' }).click();
    await expect(history.locator('ol > li')).toHaveCount(50);
    await history.getByRole('button', { name: 'Load older register changes' }).click();
    await expect(history.locator('ol > li')).toHaveCount(52);
    await expect(history.getByRole('button', { name: 'Load older register changes' })).toHaveCount(0);
    await expect(history.locator('ol > li').last().getByText('Changed fields: status')).toBeVisible();
  });

  test('an Owner can page older detailed Minute Book decisions', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    await withDb(async (client) => {
      await client.query(
        `UPDATE "Subscription" SET "plan" = 'COMPLETE', "updatedAt" = CURRENT_TIMESTAMP
         WHERE "organisationId" = $1`, [owner.organisationId],
      );
      await client.query(
        `INSERT INTO "MinuteBookChangeAudit"
          ("id", "organisationId", "recordKind", "recordId", "action", "actorUserId",
           "beforeState", "afterState", "occurredAt")
         SELECT 'dpo-minute-change-' || $2::text || '-' || lpad(n::text, 3, '0'),
           $1, 'ACT', 'synthetic-act', 'UPDATE', 'synthetic-admin',
           '{"status":"DRAFT"}'::jsonb, '{"status":"APPROVED"}'::jsonb,
           '2026-09-29T10:00:00Z'::timestamptz
         FROM generate_series(1, 52) AS n`,
        [owner.organisationId, stamp],
      );
    });

    await gotoWithDevServerRetry(ownerPage, '/minute-book');
    const history = ownerPage.locator('[aria-label="Detailed Minute Book change history"]');
    await history.getByRole('button', { name: 'Load detailed history' }).click();
    await expect(history.locator('ol > li')).toHaveCount(50);
    await history.getByRole('button', { name: 'Load older Minute Book changes' }).click();
    await expect(history.locator('ol > li')).toHaveCount(52);
    await expect(history.getByRole('button', { name: 'Load older Minute Book changes' })).toHaveCount(0);
    await history.locator('ol > li').last().getByText('Inspect retained before and after record').click();
    await expect(history.locator('ol > li').last().getByText('APPROVED')).toBeVisible();
  });

  test('an Owner can page through older detailed document decisions with tied timestamps', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    const documentId = `dpo-history-${stamp}`;
    const occurredAt = new Date(stamp + 24 * 60 * 60 * 1000);
    await withDb(async (client) => {
      await client.query(
        `INSERT INTO "DocumentControlAudit"
          ("id", "organisationId", "documentId", "actorUserId", "kind", "previous", "next", "reason", "occurredAt")
         SELECT 'control-' || $2::text || '-' || lpad(n::text, 3, '0'), $1, $3, 'synthetic-admin',
           'METADATA', 'old', 'new', 'Synthetic control row ' || lpad(n::text, 3, '0'),
           $4::timestamptz
         FROM generate_series(1, 101) AS n`,
        [owner.organisationId, stamp, documentId, occurredAt],
      );
      await client.query(
        `INSERT INTO "DocumentVisibilityAudit"
          ("id", "organisationId", "documentId", "actorUserId", "previous", "next", "reason", "occurredAt")
         SELECT 'visibility-' || $2::text || '-' || lpad(n::text, 3, '0'), $1, $3, 'synthetic-admin',
           'RESTRICTED'::"DocumentVisibility", 'MEMBER_VISIBLE'::"DocumentVisibility",
           'Synthetic visibility row ' || lpad(n::text, 3, '0'), $4::timestamptz
         FROM generate_series(1, 101) AS n`,
        [owner.organisationId, stamp, documentId, occurredAt],
      );
    });

    await gotoWithDevServerRetry(ownerPage, '/documents');
    const history = ownerPage.getByRole('region', { name: 'Document control history' });
    await history.getByRole('button', { name: 'Load history' }).click();
    await expect(history.locator('ol > li')).toHaveCount(50);
    await expect(history.getByText('Synthetic control row 101', { exact: true })).toBeVisible();
    for (const count of [100, 150, 200, 202]) {
      await history.getByRole('button', { name: 'Load older changes' }).click();
      await expect(history.locator('ol > li')).toHaveCount(count);
    }
    await expect(history.getByText('Synthetic visibility row 001', { exact: true })).toBeVisible();
    await expect(history.getByRole('button', { name: 'Load older changes' })).toHaveCount(0);
  });

  test('an Owner can reach files beyond the first Vault page without treating partial counts as complete', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    const oldestName = `DPO legacy statutory register ${stamp}`;
    await withDb((client) => client.query(
      `INSERT INTO "Document"
        ("id", "organisationId", "name", "category", "fileUrl", "fileSize", "mimeType",
         "visibility", "lifecycleStatus", "createdAt", "updatedAt")
       SELECT 'dpo-vault-page-' || $2::text || '-' || lpad(n::text, 3, '0'), $1,
         CASE WHEN n = 52 THEN $3 ELSE 'DPO review fixture ' || lpad(n::text, 3, '0') END,
         'OTHER', $1 || '/dpo-review-fixture-' || $2::text || '-' || n::text || '.txt',
         7, 'text/plain', 'RESTRICTED', 'UNREVIEWED',
         CURRENT_TIMESTAMP - (n || ' minutes')::interval, CURRENT_TIMESTAMP
       FROM generate_series(1, 52) AS n`,
      [owner.organisationId, stamp, oldestName],
    ));

    await gotoWithDevServerRetry(ownerPage, '/documents');
    await expect(ownerPage.getByText(oldestName, { exact: true })).toHaveCount(0);
    await expect(ownerPage.getByText(/Showing 50 of \d+ documents/)).toBeVisible();
    await expect(ownerPage.getByText('Partial Vault view')).toHaveCount(2);
    await withDb((client) => client.query(
      `INSERT INTO "Document"
        ("id", "organisationId", "name", "category", "fileUrl", "fileSize", "mimeType",
         "visibility", "lifecycleStatus", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'OTHER', $4, 7, 'text/plain', 'RESTRICTED', 'UNREVIEWED',
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`dpo-vault-new-${stamp}`, owner.organisationId, `New DPO file ${stamp}`,
        `${owner.organisationId}/dpo-review-new-${stamp}.txt`],
    ));
    await ownerPage.getByRole('button', { name: 'Load older documents' }).click();
    await expect(ownerPage.getByText(oldestName, { exact: true })).toBeVisible();
    await expect(ownerPage.getByRole('button', { name: 'Load older documents' })).toHaveCount(0);
    await expect(ownerPage.getByText('Vault changed during review')).toBeVisible();
    await expect(ownerPage.getByText('Partial Vault view')).toHaveCount(2);
    await ownerPage.getByRole('button', { name: 'Refresh documents' }).click();
    await ownerPage.getByRole('button', { name: 'Load older documents' }).click();
    await expect(ownerPage.getByText(oldestName, { exact: true })).toBeVisible();
    await expect(ownerPage.getByText('Vault changed during review')).toHaveCount(0);
    await expect(ownerPage.getByText('Partial Vault view')).toHaveCount(0);
  });

  test('an Owner can review all failed cleanup jobs and requeue a reviewed target', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    const prefix = `dpo-failed-${stamp}`;
    await withDb((client) => client.query(
      `INSERT INTO "DocumentStorageDeletion"
        ("id", "organisationId", "storagePath", "provider", "state", "attempts",
         "lastAttemptAt", "deadLetteredAt", "terminalReason", "nextAttemptAt", "lastError")
       SELECT $2 || '-' || lpad(n::text, 3, '0'), $1,
         $1 || '/synthetic-failed-' || $2 || '-' || lpad(n::text, 3, '0') || '.txt',
         'local', 'DEAD_LETTER', 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
         'MAX_ATTEMPTS_EXHAUSTED', NULL, 'private synthetic provider error'
       FROM generate_series(1, 52) AS n`,
      [owner.organisationId, prefix],
    ));

    await gotoWithDevServerRetry(ownerPage, '/documents');
    const review = ownerPage.getByRole('region', { name: 'Failed storage deletion jobs' });
    await review.getByRole('button', { name: 'Load failed jobs' }).click();
    await expect(review.locator('ol > li')).toHaveCount(50);
    await review.getByRole('button', { name: 'Load older failed jobs' }).click();
    await expect(review.locator('ol > li')).toHaveCount(52);
    await expect(review.getByText('private synthetic provider error')).toHaveCount(0);
    const jobId = `${prefix}-001`;
    const job = review.locator('ol > li').filter({ hasText: `Job ${jobId}` });
    await job.getByRole('button', { name: 'Review cleanup retry' }).click();
    const submit = review.getByRole('button', { name: 'Queue cleanup retry' });
    await expect(submit).toBeDisabled();
    await reliableFill(review.getByLabel('Reason for cleanup retry'),
      'Synthetic provider configuration repaired for retry.');
    await reliableFill(review.getByLabel('Type REQUEUE DOCUMENT STORAGE DELETION'),
      'REQUEUE DOCUMENT STORAGE DELETION');
    await expect(submit).toBeEnabled();
    const queued = ownerPage.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/documents/storage-deletions/${jobId}/requeue`)
      && response.request().method() === 'POST');
    await submit.click();
    expect((await queued).status()).toBe(200);
    await expect(review.getByText('Cleanup retry queued.', { exact: false })).toBeVisible();
    const audit = await withDb((client) => client.query<{ actorType: string; disposition: string }>(
      `SELECT "actorType", "disposition" FROM "DocumentStorageDeletionRecovery"
       WHERE "deletionId" = $1 AND "organisationId" = $2`,
      [jobId, owner.organisationId],
    ));
    assert.deepEqual(audit.rows, [{ actorType: 'TENANT_USER', disposition: 'REQUEUE_UNCHANGED' }]);
  });

  test('an Owner can find the Minute Book, governance audit, document controls and data-request queue', async ({ ownerPage }) => {
    test.setTimeout(120_000);

    await gotoWithDevServerRetry(ownerPage, '/security-data');
    await expect(ownerPage.getByRole('heading', { name: 'Security & Data', exact: true })).toBeVisible();
    await expect(ownerPage.getByRole('link', { name: 'Open Governance Audit' })).toBeVisible();
    await expect(ownerPage.getByRole('link', { name: 'Open Data Requests' })).toBeVisible();
    await expect(ownerPage.getByRole('link', { name: 'Open Documents' })).toBeVisible();

    await ownerPage.getByRole('link', { name: 'Open Governance Audit' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Governance Audit', exact: true })).toBeVisible();
    await expect(ownerPage.getByRole('heading', { name: 'Minute Book changes' })).toBeVisible();
    await expect(ownerPage.getByRole('heading', { name: 'Document visibility decisions' })).toBeVisible();
    await ownerPage.locator('#dashboard-content').getByRole('link', { name: 'Minute Book', exact: true }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Minute Book', exact: true })).toBeVisible();
    await expect(ownerPage.getByRole('button', { name: 'Add governing act' })).toBeVisible();

    await gotoWithDevServerRetry(ownerPage, '/security-data');
    await ownerPage.getByRole('link', { name: 'Open Data Requests' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Data Requests', exact: true })).toBeVisible();
    await expect(ownerPage.getByText(/This queue records intake, triage and reviewed links/)).toBeVisible();

    await gotoWithDevServerRetry(ownerPage, '/security-data');
    await ownerPage.getByRole('link', { name: 'Open Documents' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Document Vault', exact: true })).toBeVisible();
    const documentName = `DPO controls review ${Date.now()}`;
    await ownerPage.getByRole('button', { name: /Upload document/i }).click();
    await reliableFill(ownerPage.getByLabel('Document name'), documentName);
    await ownerPage.locator('#document-upload-file').setInputFiles(SAMPLE_FILE);
    const uploaded = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/documents$/.test(response.url()) && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Upload', exact: true }).click();
    const uploadedResponse = await uploaded;
    expect(uploadedResponse.status()).toBe(201);
    const row = ownerPage.getByRole('article').filter({ hasText: documentName });
    await expect(row.getByRole('button', { name: `Review access for ${documentName}` })).toBeVisible();
    await expect(row.getByRole('button', { name: `Classify ${documentName}` })).toBeVisible();
    await expect(row.getByRole('button', { name: `Review deletion hold for ${documentName}` })).toBeVisible();
  });

  test('a reasoned Vault hold also blocks direct database deletion', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    await gotoWithDevServerRetry(ownerPage, '/documents');
    const documentName = `DPO deletion hold ${Date.now()}`;
    await ownerPage.getByRole('button', { name: /Upload document/i }).click();
    await reliableFill(ownerPage.getByLabel('Document name'), documentName);
    await ownerPage.locator('#document-upload-file').setInputFiles(SAMPLE_FILE);
    const uploaded = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/documents$/.test(response.url()) && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Upload', exact: true }).click();
    const uploadedResponse = await uploaded;
    expect(uploadedResponse.status()).toBe(201);
    const uploadedPayload = (await uploadedResponse.json()) as { data?: { id?: string } };
    const documentId = uploadedPayload.data?.id;
    if (!documentId) throw new Error('The uploaded document has no server-issued ID');

    const row = ownerPage.getByRole('article').filter({ hasText: documentName });
    await row.getByRole('button', { name: `Review deletion hold for ${documentName}` }).click();
    await reliableFill(ownerPage.getByLabel('Reason for this decision'), 'Retain the synthetic file while its disposition is reviewed.');
    const placed = ownerPage.waitForResponse((response) =>
      response.url().includes(`/api/v1/documents/${documentId}/deletion-hold`)
      && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Place hold', exact: true }).click();
    expect((await placed).status()).toBe(200);

    await assert.rejects(() => withDb((client) => client.query(
      `DELETE FROM "Document" WHERE "id" = $1 AND "organisationId" = $2`,
      [documentId, owner.organisationId],
    )), /code=23514/);
    const retained = await withDb((client) => client.query<{ deletionHold: boolean }>(
      `SELECT "deletionHold" FROM "Document" WHERE "id" = $1 AND "organisationId" = $2`,
      [documentId, owner.organisationId],
    ));
    assert.deepEqual(retained.rows, [{ deletionHold: true }]);
    await expect(row.getByText('Deletion hold', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: `Delete ${documentName}` })).toBeDisabled();
  });

  test('an Owner sees integration event metadata without private site details in Governance Audit', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const eventId = `dpo-integration-${Date.now()}`;
    await withDb((client) => client.query(
      `INSERT INTO "SecurityAuditEvent"
        ("id", "organisationId", "type", "actorKind", "actorLabel", "subjectLabel", "reason", "context")
       VALUES ($1, $2, 'INTEGRATION_CONNECTED', 'SYSTEM', 'Synthetic scheduler',
         'Private test site', 'Private integration reason', '{"siteUrl":"https://private.example"}'::jsonb)`,
      [eventId, owner.organisationId],
    ));
    const feedResponse = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/governance-audit\/integrations$/.test(response.url())
      && response.request().method() === 'GET');
    await gotoWithDevServerRetry(ownerPage, '/governance-audit');
    const response = await feedResponse;
    expect(response.status()).toBe(200);
    const payload = (await response.json()) as { data?: Array<{ id: string }> };
    assert.ok(payload.data?.some((event) => event.id === eventId));
    assert.doesNotMatch(JSON.stringify(payload), /Private test site|Private integration reason|private\.example/);
    const section = ownerPage.locator('section').filter({
      has: ownerPage.getByRole('heading', { name: 'Confluence integration events' }),
    });
    await expect(section.getByText(`Connection established · event ${eventId}`, { exact: true })).toBeVisible();
  });

  test('an Owner can find and separately request erasure of a retired Confluence copy', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    const publicationId = `dpo-retired-${stamp}`;
    const documentId = `dpo-removed-${stamp}`;
    const title = `Synthetic retired page ${stamp}`;
    await withDb(async (client) => {
      await client.query(
        `INSERT INTO "OrganisationIntegration"
          ("id", "organisationId", "provider", "status", "config", "grantedScopes", "updatedAt")
         VALUES ($1, $2, 'CONFLUENCE', 'CONNECTED', '{"siteId":"fake-cloud-id","siteUrl":"https://fake.example"}'::jsonb,
           ARRAY['delete:page:confluence','delete:attachment:confluence']::text[], CURRENT_TIMESTAMP)`,
        [`dpo-integration-${stamp}`, owner.organisationId],
      );
      await client.query(
        `INSERT INTO "DocumentPublication"
          ("id", "organisationId", "documentId", "provider", "cloudId", "pageId", "pageTitle",
           "publishedAt", "state", "retiredAt", "retiredStoragePath", "nextAttemptAt")
         VALUES ($1, $2, $3, 'confluence', 'fake-cloud-id', $4, $5,
           CURRENT_TIMESTAMP, 'RETIRED', CURRENT_TIMESTAMP, $6, NULL)`,
        [publicationId, owner.organisationId, documentId, `page-${stamp}`, title, `${owner.organisationId}/retired-${stamp}.pdf`],
      );
    });
    await gotoWithDevServerRetry(ownerPage, '/integrations');
    const section = ownerPage.locator('section').filter({
      has: ownerPage.getByRole('heading', { name: 'Retired Confluence copies' }),
    });
    await expect(section.getByText(title, { exact: true })).toBeVisible();
    await expect(section.getByText(`Recorded Confluence target: site fake-cloud-id · space unknown · page page-${stamp}`)).toBeVisible();
    await section.getByRole('button', { name: 'Review erasure request' }).click();
    const requestButton = section.getByRole('button', { name: 'Request Confluence erasure' });
    await expect(requestButton).toBeDisabled();
    await reliableFill(section.getByLabel(`Reason for erasing ${title}`),
      'Synthetic authorised review of this retired external copy.');
    await section.getByLabel('Type ERASE CONFLUENCE COPY').fill('ERASE CONFLUENCE COPY');
    await expect(requestButton).toBeEnabled();
    const requested = ownerPage.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/integrations/confluence/publications/${publicationId}/erase`)
      && response.request().method() === 'POST');
    await requestButton.click();
    const response = await requested;
    expect(response.status()).toBe(200);
    const jobId = ((await response.json()) as { data: { storageDeletionId: string } }).data.storageDeletionId;
    await expect(section.getByText(`Erasure request recorded as technical job ${jobId}`, { exact: false })).toBeVisible();
    await expect(section.getByText('Erasure request recorded; check the deletion job outcome.')).toBeVisible();
    const linked = await withDb((client) => client.query<{ erasureDeletionId: string }>(
      `SELECT "erasureDeletionId" FROM "DocumentPublication" WHERE "id" = $1 AND "organisationId" = $2`,
      [publicationId, owner.organisationId],
    ));
    assert.equal(linked.rows[0].erasureDeletionId, jobId);
  });

  test('an Owner can review a recorded non-retired Confluence copy with no linked Vault document', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    const publicationId = `dpo-other-${stamp}`;
    const title = `Synthetic recorded copy ${stamp}`;
    const currentDocumentId = `dpo-current-${stamp}`;
    const mismatchedTitle = `Synthetic old-space copy ${stamp}`;
    await withDb(async (client) => {
      await client.query(
        `INSERT INTO "DocumentPublication"
          ("id", "organisationId", "documentId", "provider", "cloudId", "pageId", "pageTitle",
           "publishedAt", "processedAt", "state", "nextAttemptAt")
         VALUES ($1, $2, $3, 'confluence', 'fake-cloud-id', $4, $5,
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'PROCESSED', NULL)`,
        [publicationId, owner.organisationId, `missing-document-${stamp}`, `page-${stamp}`, title],
      );
      await client.query(
        `INSERT INTO "Document"
          ("id", "organisationId", "name", "category", "visibility", "lifecycleStatus",
           "externalPublicationApproved", "externalPublicationSiteId", "externalPublicationSpaceId",
           "fileUrl", "fileSize", "mimeType", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 'POLICY', 'RESTRICTED', 'CURRENT',
           true, 'fake-cloud-id', 'new-space', $4, 12, 'text/plain', NOW(), NOW())`,
        [currentDocumentId, owner.organisationId, `Current policy ${stamp}`, `${owner.organisationId}/current-${stamp}.txt`],
      );
      await client.query(
        `INSERT INTO "DocumentPublication"
          ("id", "organisationId", "documentId", "provider", "cloudId", "spaceId", "pageId", "pageTitle",
           "publishedAt", "processedAt", "state", "nextAttemptAt")
         VALUES ($1, $2, $3, 'confluence', 'fake-cloud-id', 'old-space', $4, $5,
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'PROCESSED', NULL)`,
        [`dpo-old-space-${stamp}`, owner.organisationId, currentDocumentId, `old-page-${stamp}`, mismatchedTitle],
      );
    });
    await gotoWithDevServerRetry(ownerPage, '/integrations');
    const section = ownerPage.locator('section').filter({
      has: ownerPage.getByRole('heading', { name: 'Other recorded Confluence copies' }),
    });
    const row = section.locator('li').filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(row.getByText(`Recorded Confluence target: site fake-cloud-id · space unknown · page page-${stamp}`)).toBeVisible();
    await expect(row.getByText('The linked Vault document was not found.', { exact: false })).toBeVisible();
    await expect(row.getByText('Review this recorded external copy and its audience', { exact: false })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Request Confluence erasure' })).toHaveCount(0);
    const mismatched = section.locator('li').filter({ hasText: mismatchedTitle });
    await expect(mismatched.getByText(`Recorded Confluence target: site fake-cloud-id · space old-space · page old-page-${stamp}`)).toBeVisible();
    await expect(mismatched.getByText('approval target matches this recorded page: no', { exact: false })).toBeVisible();
  });

  test('an Owner can locate a charity-managed cited page without an erasure action', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const stamp = Date.now();
    const documentId = `dpo-cited-document-${stamp}`;
    const citationId = `dpo-citation-${stamp}`;
    const title = `Synthetic cited evidence ${stamp}`;
    await withDb(async (client) => {
      await client.query(
        `INSERT INTO "Document"
          ("id", "organisationId", "name", "category", "visibility", "lifecycleStatus",
           "fileUrl", "fileSize", "mimeType", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 'POLICY', 'RESTRICTED', 'SUPERSEDED',
           $4, 12, 'text/plain', NOW(), NOW())`,
        [documentId, owner.organisationId, `Cited policy ${stamp}`, `${owner.organisationId}/cited-${stamp}.txt`],
      );
      await client.query(
        `INSERT INTO "ConfluenceReference"
          ("id", "organisationId", "documentId", "cloudId", "pageId", "pageTitle",
           "pageVersion", "citedAt", "citedById", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 'charity-site', $4, $5, 7, NOW(), $6, NOW(), NOW())`,
        [citationId, owner.organisationId, documentId, `charity-page-${stamp}`, title, owner.userId],
      );
    });
    await gotoWithDevServerRetry(ownerPage, '/integrations');
    const section = ownerPage.locator('section').filter({
      has: ownerPage.getByRole('heading', { name: 'Cited Confluence evidence pages' }),
    });
    const row = section.locator('li').filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(row.getByText(`Recorded Confluence target: site charity-site · page charity-page-${stamp} · cited version 7`)).toBeVisible();
    await expect(row.getByText('lifecycle SUPERSEDED · visibility RESTRICTED', { exact: false })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Request Confluence erasure' })).toHaveCount(0);
  });

  test('an Owner records and withdraws a case response target with due attention and retained audit', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    const received = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    const target = new Date(Date.now() - 24 * 60 * 60_000);
    const actualResponse = new Date(Date.now() - 12 * 60 * 60_000);
    const caseReference = `CASE-${Date.now()}-TARGET`;
    await gotoWithDevServerRetry(ownerPage, '/data-lifecycle');
    await reliableFill(ownerPage.getByLabel('Opaque case reference'), caseReference);
    await ownerPage.getByLabel('Received date and time').fill(localInput(received));
    const recorded = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/data-lifecycle\/requests$/.test(response.url()) && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Record request' }).click();
    const intake = await recorded;
    expect(intake.status()).toBe(201);
    const requestId = ((await intake.json()) as { data: { id: string } }).data.id;
    await reliableFill(ownerPage.getByLabel('Find by case reference'), caseReference);
    await ownerPage.getByRole('button', { name: 'Find request' }).click();
    await expect(ownerPage.getByRole('heading', { name: `Review ${caseReference}` })).toBeVisible();
    const coverage = ownerPage.locator('section[aria-labelledby="coverage-title"]');
    await expect(coverage.getByText('Not reviewed', { exact: true })).toHaveCount(8);
    await coverage.getByLabel('Source area').selectOption('BACKUPS');
    await coverage.getByLabel('Assessment', { exact: true }).selectOption('NEEDS_FOLLOW_UP');
    await reliableFill(coverage.getByLabel('Reason for assessment'), 'Synthetic case needs a review of backup custody.');
    await reliableFill(coverage.getByLabel('Controlled-archive evidence reference (optional)'), 'ARCHIVE-BACKUPS-1');
    const coverageSaved = ownerPage.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/data-lifecycle/requests/${requestId}/coverage`)
      && response.request().method() === 'POST');
    await coverage.getByRole('button', { name: 'Record coverage assessment' }).click();
    expect((await coverageSaved).status()).toBe(201);
    await expect(coverage.locator('li').filter({ hasText: 'Database, object and recovery backups' }).first()
      .getByText('Needs follow-up')).toBeVisible();
    const coverageRow = await withDb((client) => client.query<{ id: string }>(
      `SELECT "id" FROM "DataLifecycleCoverageEvent" WHERE "requestId" = $1 AND "organisationId" = $2 AND "area" = 'BACKUPS'`,
      [requestId, owner.organisationId],
    ));
    assert.equal(coverageRow.rows.length, 1);
    await assert.rejects(() => withDb((client) => client.query(
      `UPDATE "DataLifecycleCoverageEvent" SET "reason" = 'Changed after recording' WHERE "id" = $1`,
      [coverageRow.rows[0].id],
    )), /query failed \(code=P0001\)/);
    await ownerPage.getByLabel('Target response date and time').fill(localInput(target));
    await reliableFill(ownerPage.getByLabel('Reason for target change'),
      'Synthetic correspondence set this operational response target.');
    await reliableFill(ownerPage.getByLabel('Opaque target evidence reference'), 'ARCHIVE-TARGET-1');
    const saved = ownerPage.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/data-lifecycle/requests/${requestId}/response-target`)
      && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Save response target' }).click();
    expect((await saved).status()).toBe(200);
    const dueSection = ownerPage.locator('section').filter({ has: ownerPage.getByRole('heading', { name: 'Past response targets' }) });
    await expect(dueSection.getByText(caseReference, { exact: true })).toBeVisible();
    await expect(ownerPage.getByText('Synthetic correspondence set this operational response target.')).toBeVisible();

    await ownerPage.getByLabel('Actual response date and time').fill(localInput(actualResponse));
    await reliableFill(ownerPage.getByLabel('Reason for response record or correction'),
      'Synthetic controlled correspondence confirms the response was sent.');
    await reliableFill(ownerPage.getByLabel('Opaque response evidence reference'), 'ARCHIVE-RESPONSE-1');
    const responseSaved = ownerPage.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/data-lifecycle/requests/${requestId}/response-sent`)
      && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Save actual response date' }).click();
    expect((await responseSaved).status()).toBe(200);
    await expect(dueSection.getByText(caseReference, { exact: true })).toHaveCount(0);
    await expect(ownerPage.getByText('Synthetic controlled correspondence confirms the response was sent.')).toBeVisible();

    const sentHistory = await withDb((client) => client.query<{ id: string }>(
      `SELECT "id" FROM "DataLifecycleResponseEvent" WHERE "requestId" = $1 AND "organisationId" = $2`,
      [requestId, owner.organisationId],
    ));
    assert.equal(sentHistory.rows.length, 1);
    await assert.rejects(() => withDb((client) => client.query(
      `UPDATE "DataLifecycleResponseEvent" SET "reason" = 'Changed after recording' WHERE "id" = $1`,
      [sentHistory.rows[0].id],
    )), /query failed \(code=P0001\)/);

    await ownerPage.getByLabel('Actual response date and time').fill('');
    await reliableFill(ownerPage.getByLabel('Reason for response record or correction'),
      'Synthetic review withdrew the incorrect response entry.');
    const responseWithdrawn = ownerPage.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/data-lifecycle/requests/${requestId}/response-sent`)
      && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Save actual response date' }).click();
    expect((await responseWithdrawn).status()).toBe(200);
    await expect(dueSection.getByText(caseReference, { exact: true })).toBeVisible();

    await ownerPage.getByLabel('Target response date and time').fill('');
    await reliableFill(ownerPage.getByLabel('Reason for target change'),
      'Synthetic correspondence superseded the earlier target.');
    const withdrawn = ownerPage.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/data-lifecycle/requests/${requestId}/response-target`)
      && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Save response target' }).click();
    expect((await withdrawn).status()).toBe(200);
    await expect(dueSection.getByText(caseReference, { exact: true })).toHaveCount(0);
    await expect(ownerPage.getByText('Synthetic correspondence superseded the earlier target.')).toBeVisible();

    const history = await withDb((client) => client.query<{ id: string }>(
      `SELECT "id" FROM "DataLifecycleTargetEvent" WHERE "requestId" = $1 AND "organisationId" = $2 ORDER BY "occurredAt"`,
      [requestId, owner.organisationId],
    ));
    assert.equal(history.rows.length, 2);
    await assert.rejects(() => withDb((client) => client.query(
      `UPDATE "DataLifecycleTargetEvent" SET "reason" = 'Changed after recording' WHERE "id" = $1`,
      [history.rows[0].id],
    )), /query failed \(code=P0001\)/);

    const auditResponse = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/governance-audit\/data-request-targets$/.test(response.url())
      && response.request().method() === 'GET');
    const responseAudit = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/governance-audit\/data-request-responses$/.test(response.url())
      && response.request().method() === 'GET');
    const coverageAudit = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/governance-audit\/data-request-coverage$/.test(response.url())
      && response.request().method() === 'GET');
    await gotoWithDevServerRetry(ownerPage, '/governance-audit');
    const audit = await auditResponse;
    expect(audit.status()).toBe(200);
    const payload = await audit.json();
    assert.equal(payload.data.filter((event: { requestId: string }) => event.requestId === requestId).length, 2);
    assert.doesNotMatch(JSON.stringify(payload), /Synthetic correspondence|ARCHIVE-TARGET-1/);
    const sentAudit = await responseAudit;
    expect(sentAudit.status()).toBe(200);
    const sentPayload = await sentAudit.json();
    assert.equal(sentPayload.data.filter((event: { requestId: string }) => event.requestId === requestId).length, 2);
    assert.doesNotMatch(JSON.stringify(sentPayload), /Synthetic controlled correspondence|ARCHIVE-RESPONSE-1/);
    const reviewedAreas = await coverageAudit;
    expect(reviewedAreas.status()).toBe(200);
    const coveragePayload = await reviewedAreas.json();
    assert.equal(coveragePayload.data.filter((event: { requestId: string }) => event.requestId === requestId).length, 1);
    assert.doesNotMatch(JSON.stringify(coveragePayload), /Synthetic case needs a review|ARCHIVE-BACKUPS-1/);
    const coverageFeed = ownerPage.locator('section').filter({ has: ownerPage.getByRole('heading', { name: 'Data request source-area reviews' }) });
    await expect(coverageFeed.getByText(`backups · needs follow up · request ${requestId}`)).toBeVisible();
  });

  test('an Owner can link a live Vault document to a case and retain the link after draft removal', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    await gotoWithDevServerRetry(ownerPage, '/documents');
    const recoveryPolicyId = await approveSyntheticDraftRecoveryPolicy(ownerPage);
    const documentName = `DPO case lineage ${Date.now()}`;
    await ownerPage.getByRole('button', { name: /Upload document/i }).click();
    await reliableFill(ownerPage.getByLabel('Document name'), documentName);
    await ownerPage.locator('#document-upload-file').setInputFiles(SAMPLE_FILE);
    const uploaded = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/documents$/.test(response.url()) && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Upload', exact: true }).click();
    const uploadResponse = await uploaded;
    expect(uploadResponse.status()).toBe(201);
    const uploadPayload = (await uploadResponse.json()) as { data?: { id?: string } };
    const documentId = uploadPayload.data?.id;
    if (!documentId) throw new Error('The uploaded document has no server-issued ID');
    await expect(ownerPage.getByRole('article').filter({ hasText: documentName })
      .getByText(documentId, { exact: true })).toBeVisible();

    await gotoWithDevServerRetry(ownerPage, '/data-lifecycle');
    const caseReference = `CASE-${Date.now()}-VAULT`;
    await reliableFill(ownerPage.getByLabel('Opaque case reference'), caseReference);
    await ownerPage.getByLabel('Data area').selectOption('DOCUMENT');
    const recorded = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/data-lifecycle\/requests$/.test(response.url()) && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Record request' }).click();
    const recordedResponse = await recorded;
    expect(recordedResponse.status()).toBe(201);
    const recordedPayload = (await recordedResponse.json()) as { data?: { id?: string } };
    const requestId = recordedPayload.data?.id;
    if (!requestId) throw new Error('The data request has no server-issued ID');
    await reliableFill(ownerPage.getByLabel('Find by case reference'), caseReference);
    await ownerPage.getByRole('button', { name: 'Find request' }).click();
    await expect(ownerPage.getByRole('heading', { name: `Review ${caseReference}` })).toBeVisible();
    await reliableFill(ownerPage.getByLabel('Vault document ID', { exact: true }), documentId);
    await reliableFill(ownerPage.getByLabel('Reason for linking Vault document'),
      'Matched the synthetic Vault record in the controlled case archive.');
    const linked = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/data-lifecycle\/requests\/[^/]+\/document-links$/.test(response.url())
      && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Link Vault document' }).click();
    expect((await linked).status()).toBe(201);
    const link = ownerPage.locator('li').filter({ has: ownerPage.getByText(documentId, { exact: true }) });
    await expect(link.getByText(/Active association/)).toBeVisible();

    await gotoWithDevServerRetry(ownerPage, '/documents');
    const row = ownerPage.getByRole('article').filter({ hasText: documentName });
    await row.getByRole('button', { name: `Delete ${documentName}` }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Move document to Deleted Items' })).toBeVisible();
    await ownerPage.getByLabel('Approved recovery policy').selectOption(recoveryPolicyId);
    await reliableFill(ownerPage.getByLabel('Removal authority reference'), 'SYNTHETIC-CASE-REMOVAL');
    await reliableFill(ownerPage.getByLabel('Reason for removing this draft'),
      'The synthetic draft was uploaded for the case journey and can be removed.');
    const removed = ownerPage.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/documents/${documentId}`) && response.request().method() === 'DELETE');
    await ownerPage.getByRole('button', { name: 'Move to Deleted Items', exact: true }).click();
    expect((await removed).status()).toBe(200);
    const remaining = await withDb((client) => client.query(
      `SELECT "id", "deletedAt" FROM "Document" WHERE "id" = $1 AND "organisationId" = $2`,
      [documentId, owner.organisationId],
    ));
    assert.equal(remaining.rows.length, 1);
    assert.ok(remaining.rows[0].deletedAt);
    await ownerPage.getByRole('button', { name: 'Load history' }).click();
    await expect(ownerPage.getByRole('listitem').filter({ hasText: 'RECORD_REMOVE:' })
      .getByText('The synthetic draft was uploaded for the case journey and can be removed.')).toBeVisible();

    await gotoWithDevServerRetry(ownerPage, '/data-lifecycle');
    await reliableFill(ownerPage.getByLabel('Find by case reference'), caseReference);
    await ownerPage.getByRole('button', { name: 'Find request' }).click();
    const historicalLink = ownerPage.locator('li').filter({ has: ownerPage.getByText(documentId, { exact: true }) });
    await expect(historicalLink.getByText(/Active association/)).toBeVisible();
    await historicalLink.getByRole('button', { name: 'Withdraw association' }).click();
    await reliableFill(historicalLink.getByLabel(`Reason for withdrawing ${documentId}`),
      'The synthetic association was withdrawn after document removal.');
    const withdrawn = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/data-lifecycle\/requests\/[^/]+\/document-links\/[^/]+\/withdraw$/.test(response.url())
      && response.request().method() === 'POST');
    await historicalLink.getByRole('button', { name: 'Record withdrawal' }).click();
    expect((await withdrawn).status()).toBe(201);
    await expect(historicalLink.getByText(/Withdrawn association/)).toBeVisible();

    await gotoWithDevServerRetry(ownerPage, '/governance-audit');
    const evidenceLinks = ownerPage.locator('section').filter({
      has: ownerPage.getByRole('heading', { name: 'Data request evidence links' }),
    });
    await expect(evidenceLinks.getByText(`Association recorded · Vault ${documentId} · request ${requestId}`, { exact: true })).toBeVisible();
    await expect(evidenceLinks.getByText(`Association withdrawn · Vault link`, { exact: false })).toBeVisible();
  });

  test('an unreviewed legacy document cannot be newly released to Members', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    await gotoWithDevServerRetry(ownerPage, '/documents');
    await expect(ownerPage.getByRole('heading', { name: 'Document Vault', exact: true })).toBeVisible();
    const documentName = `DPO unreviewed guard ${Date.now()}`;
    await ownerPage.getByRole('button', { name: /Upload document/i }).click();
    await reliableFill(ownerPage.getByLabel('Document name'), documentName);
    await ownerPage.locator('#document-upload-file').setInputFiles(SAMPLE_FILE);
    const uploaded = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/documents$/.test(response.url()) && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Upload', exact: true }).click();
    const uploadedResponse = await uploaded;
    expect(uploadedResponse.status()).toBe(201);
    const uploadedPayload = (await uploadedResponse.json()) as { data?: { id?: string } };
    const uploadedId = uploadedPayload.data?.id;
    if (!uploadedId) throw new Error('The uploaded document has no server-issued ID');
    await withDb((client) => client.query(
      `UPDATE "Document" SET "lifecycleStatus" = 'UNREVIEWED'
        WHERE "id" = $1 AND "organisationId" = $2`,
      [uploadedId, owner.organisationId],
    ));
    await gotoWithDevServerRetry(ownerPage, '/documents');
    const unreviewed = ownerPage.getByRole('article').filter({ hasText: documentName });
    await unreviewed.getByRole('button', { name: `Review access for ${documentName}` }).click();
    await expect(ownerPage.getByText('This document is unreviewed. Classify its lifecycle before allowing Member access.')).toBeVisible();
    await ownerPage.getByLabel('Content assessment').selectOption('MEMBER_SUITABLE');
    await reliableFill(ownerPage.getByLabel('Reason for this access decision'), 'The file must be classified before release.');
    await expect(ownerPage.getByRole('button', { name: 'Allow Members' })).toBeDisabled();
    await ownerPage.getByRole('button', { name: 'Cancel' }).click();
    await assert.rejects(() => withDb((client) => client.query(
      `UPDATE "Document" SET "visibility" = 'MEMBER_VISIBLE' WHERE "id" = $1 AND "organisationId" = $2`,
      [uploadedId, owner.organisationId],
    )), /code=23514/);
  });

  test('an Owner assesses file content before Members can see a Vault document', async ({ owner, ownerPage, newFencedContext }) => {
    test.setTimeout(120_000);
    const documentName = `DPO assessed access ${Date.now()}`;
    await gotoWithDevServerRetry(ownerPage, '/documents');
    await ownerPage.getByRole('button', { name: /Upload document/i }).click();
    await reliableFill(ownerPage.getByLabel('Document name'), documentName);
    await ownerPage.locator('#document-upload-file').setInputFiles(SAMPLE_FILE);
    const uploaded = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/documents$/.test(response.url()) && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Upload', exact: true }).click();
    const uploadResponse = await uploaded;
    expect(uploadResponse.status()).toBe(201);
    const documentId = ((await uploadResponse.json()) as { data?: { id?: string } }).data?.id;
    if (!documentId) throw new Error('The uploaded document has no server-issued ID');

    const ownerArticle = ownerPage.getByRole('article').filter({ hasText: documentName });
    await ownerArticle.getByRole('button', { name: `Classify ${documentName}` }).click();
    await ownerPage.getByLabel('New lifecycle status').selectOption('CURRENT');
    await reliableFill(ownerPage.getByLabel('Reason for this decision'), 'The working document has been approved as current evidence.');
    await ownerPage.getByRole('button', { name: 'Save status' }).click();
    await expect(ownerArticle.getByText('CURRENT', { exact: true })).toBeVisible();

    await ownerArticle.getByRole('button', { name: `Review access for ${documentName}` }).click();
    await ownerPage.getByLabel('Content assessment').selectOption('RESTRICTED_SENSITIVE');
    await reliableFill(ownerPage.getByLabel('Reason for this access decision'), 'The full file contains trustee particulars and must stay restricted.');
    await ownerPage.getByRole('button', { name: 'Save restricted assessment' }).click();
    await expect(ownerArticle.getByText('Sensitive content', { exact: true })).toBeVisible();

    const member = await createVerifiedMember({
      email: uniqueEmail('dpo-content-member'), name: 'DPO Content Member', organisationId: owner.organisationId,
    });
    const storageState = await createAuthenticatedStorageState({
      userId: member.userId, organisationId: member.organisationId, role: member.role,
    });
    const memberContext = await newFencedContext({ storageState });
    const memberPage = await memberContext.newPage();
    await gotoWithDevServerRetry(memberPage, '/documents');
    await expect(memberPage.getByText(documentName, { exact: true })).toHaveCount(0);

    await ownerArticle.getByRole('button', { name: `Review access for ${documentName}` }).click();
    await ownerPage.getByLabel('Content assessment').selectOption('MEMBER_SUITABLE');
    await reliableFill(ownerPage.getByLabel('Reason for this access decision'),
      'The current file needs a matching authenticated review download.');
    const refusedRelease = ownerPage.waitForResponse(
      (response) => /\/api\/v1\/documents\/[^/]+$/.test(response.url()) && response.request().method() === 'PATCH',
    );
    await ownerPage.getByRole('button', { name: 'Allow Members' }).click();
    const refusedResponse = await refusedRelease;
    expect(refusedResponse.status()).toBe(409);
    expect(((await refusedResponse.json()) as { code?: string }).code).toBe('DOCUMENT_REVIEW_DOWNLOAD_REQUIRED');
    await ownerPage.getByRole('button', { name: 'Cancel' }).click();

    const ownerReviewDownload = ownerPage.waitForResponse(
      (response) => /\/api\/v1\/documents\/[^/]+\/download$/.test(response.url()) && response.request().method() === 'GET',
    );
    await ownerArticle.getByRole('button', { name: `Download ${documentName}` }).click();
    expect((await ownerReviewDownload).status()).toBe(200);
    await ownerArticle.getByRole('button', { name: `Review access for ${documentName}` }).click();
    await ownerPage.getByLabel('Content assessment').selectOption('MEMBER_SUITABLE');
    await reliableFill(ownerPage.getByLabel('Reason for this access decision'),
      'Reviewed the full file and metadata as suitable for all active Members.');
    await ownerPage.getByRole('button', { name: 'Allow Members' }).click();
    await expect(ownerArticle.getByText('Content reviewed for Members', { exact: true })).toBeVisible();
    await gotoWithDevServerRetry(memberPage, '/documents');
    await expect(memberPage.getByText(documentName, { exact: true })).toBeVisible();

    await ownerArticle.getByRole('button', { name: `Review access for ${documentName}` }).click();
    await reliableFill(ownerPage.getByLabel('Reason for this access decision'),
      'The Member audience is withdrawn pending a further access review.');
    await ownerPage.getByRole('button', { name: 'Restrict Members' }).click();
    await gotoWithDevServerRetry(memberPage, '/documents');
    await expect(memberPage.getByText(documentName, { exact: true })).toHaveCount(0);
    const assessment = await withDb((client) => client.query(
      `SELECT "contentAccessClass" FROM "Document" WHERE "id" = $1 AND "organisationId" = $2`,
      [documentId, owner.organisationId],
    ));
    expect(assessment.rows[0]?.contentAccessClass).toBe('MEMBER_SUITABLE');
  });

  test('an Owner sees an unverified legacy storage provider and cannot delete it after a failed review', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const documentId = `dpo-legacy-custody-${Date.now()}`;
    const documentName = `DPO legacy custody ${Date.now()}`;
    await withDb((client) => client.query(
      `INSERT INTO "Document"
        ("id", "organisationId", "name", "category", "visibility", "lifecycleStatus",
         "fileUrl", "fileSize", "mimeType", "storageProvider", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'POLICY', 'RESTRICTED', 'DRAFT', $4, 12, 'text/plain', NULL, NOW(), NOW())`,
      [documentId, owner.organisationId, documentName, `${owner.organisationId}/${documentId}.txt`],
    ));

    await gotoWithDevServerRetry(ownerPage, '/documents');
    const row = ownerPage.getByRole('article').filter({ hasText: documentName });
    await expect(row.getByText('Storage provider unverified')).toBeVisible();
    await expect(row.getByRole('button', { name: `Delete ${documentName}` })).toBeDisabled();
    await row.getByRole('button', { name: `Verify file storage for ${documentName}` }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Verify file storage' })).toBeVisible();
    const checked = ownerPage.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/documents/${documentId}/verify-storage-provider`)
      && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Check both providers' }).click();
    expect((await checked).status()).toBe(503);
    const persisted = await withDb((client) => client.query(
      `SELECT "storageProvider" FROM "Document" WHERE "id" = $1 AND "organisationId" = $2`,
      [documentId, owner.organisationId],
    ));
    assert.equal(persisted.rows[0]?.storageProvider, null);
    await ownerPage.getByRole('button', { name: 'Cancel' }).click();
    await expect(row.getByRole('button', { name: `Delete ${documentName}` })).toBeDisabled();
  });

  test('an Owner sees recoverable removal in Governance Audit without a cleanup receipt', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    await gotoWithDevServerRetry(ownerPage, '/documents');
    const policyId = await approveSyntheticDraftRecoveryPolicy(ownerPage);
    const name = `DPO retained audit ${Date.now()}`;
    await ownerPage.getByRole('button', { name: /Upload document/i }).click();
    await reliableFill(ownerPage.getByLabel('Document name'), name);
    await ownerPage.locator('#document-upload-file').setInputFiles(SAMPLE_FILE);
    const uploaded = ownerPage.waitForResponse(response => /\/api\/v1\/documents$/.test(response.url()) && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Upload', exact: true }).click();
    const uploadResponse = await uploaded;
    expect(uploadResponse.status()).toBe(201);
    const documentId = (await uploadResponse.json()).data.id as string;
    const row = ownerPage.getByRole('article').filter({ hasText: name });
    await row.getByRole('button', { name: `Delete ${name}` }).click();
    await ownerPage.getByLabel('Approved recovery policy').selectOption(policyId);
    await reliableFill(ownerPage.getByLabel('Removal authority reference'), 'SYNTHETIC-AUDIT-REMOVAL');
    await reliableFill(ownerPage.getByLabel('Reason for removing this draft'), 'The synthetic draft is retained for the audit rehearsal.');
    const removed = ownerPage.waitForResponse(response => response.url().endsWith(`/documents/${documentId}`) && response.request().method() === 'DELETE');
    await ownerPage.getByRole('button', { name: 'Move to Deleted Items', exact: true }).click();
    expect((await removed).status()).toBe(200);
    const jobs = await withDb(client => client.query(`SELECT id FROM "DocumentStorageDeletion" WHERE "sourceDocumentId"=$1`, [documentId]));
    expect(jobs.rowCount).toBe(0);
    const auditRead = ownerPage.waitForResponse(response => response.url().includes('/governance-audit/document-controls') && response.request().method() === 'GET');
    await gotoWithDevServerRetry(ownerPage, '/governance-audit');
    const auditResponse = await auditRead;
    expect(auditResponse.status()).toBe(200);
    const payload = await auditResponse.json();
    expect(payload.data.some((event: { documentId: string; kind: string }) => event.documentId === documentId && event.kind === 'RECORD_REMOVE')).toBe(true);
    const controls = ownerPage.locator('section').filter({ has: ownerPage.getByRole('heading', { name: 'Document changes and controls' }) });
    await expect(controls.getByText(new RegExp(`RECORD_REMOVE.*${documentId}`))).toBeVisible();
  });
  test('an Owner can page past new data-request intake without losing older cases', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const batch = Date.now().toString();
    const receivedAt = new Date(Date.now() - 60_000).toISOString();
    await withDb(async (client) => {
      await client.query(
        `INSERT INTO "DataLifecycleRequest"
          ("id", "organisationId", "caseReference", "kind", "scope", "receivedAt", "enteredById", "updatedAt")
         SELECT $1 || '-' || lpad(n::text, 3, '0'), $2,
           'CASE-' || $1 || '-' || lpad(n::text, 3, '0'), 'ERASURE', 'DOCUMENT', $4, $3, now()
         FROM generate_series(1, 52) AS n`,
        [batch, owner.organisationId, owner.userId, receivedAt],
      );
    });

    await gotoWithDevServerRetry(ownerPage, '/data-lifecycle');
    await expect(ownerPage.getByRole('heading', { name: 'Data Requests', exact: true })).toBeVisible();
    await expect(ownerPage.getByText(`CASE-${batch}-052`, { exact: true })).toBeVisible();
    await expect(ownerPage.getByText(`CASE-${batch}-002`, { exact: true })).toHaveCount(0);

    await reliableFill(ownerPage.getByLabel('Find by case reference'), `CASE-${batch}-001`);
    await ownerPage.getByRole('button', { name: 'Find request' }).click();
    await expect(ownerPage.getByRole('heading', { name: `Review CASE-${batch}-001` })).toBeVisible();

    await withDb(async (client) => {
      await client.query(
        `INSERT INTO "DataLifecycleRequest"
          ("id", "organisationId", "caseReference", "kind", "scope", "receivedAt", "enteredById", "updatedAt")
         VALUES ($1, $2, $3, 'ERASURE', 'DOCUMENT', $4, $5, now())`,
        [`${batch}-999`, owner.organisationId, `CASE-${batch}-999`, receivedAt, owner.userId],
      );
    });

    const older = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/data-lifecycle\/requests\?before=/.test(response.url()) && response.request().method() === 'GET');
    await ownerPage.getByRole('button', { name: 'Load older requests' }).click();
    expect((await older).status()).toBe(200);
    await expect(ownerPage.getByText(`CASE-${batch}-002`, { exact: true })).toBeVisible();
    await expect(ownerPage.getByText(`CASE-${batch}-001`, { exact: true })).toBeVisible();
    await expect(ownerPage.getByRole('button', { name: 'Load older requests' })).toHaveCount(0);
  });

  test('a Member sees personal security settings while restricted review areas remain closed', async ({ owner, newFencedContext }) => {
    test.setTimeout(120_000);
    const member = await createVerifiedMember({
      email: uniqueEmail('dpo-member'),
      name: 'DPO Review Member',
      organisationId: owner.organisationId,
    });
    const storageState = await createAuthenticatedStorageState({
      userId: member.userId,
      organisationId: member.organisationId,
      role: member.role,
    });
    const context = await newFencedContext({ storageState });
    const page = await context.newPage();

    await gotoWithDevServerRetry(page, '/security-data');
    await expect(page.getByRole('heading', { name: 'Security & Data', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Manage your sessions' })).toBeVisible();
    await expect(page.getByText('Only Owners and Admins can review charity-wide security, audit and data controls.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Governance Audit' })).toHaveCount(0);

    for (const [route, heading, warning] of [
      ['/minute-book', 'Minute Book', /Owners and administrators can review the Minute Book/],
      ['/governance-audit', 'Governance Audit', /Only Owners and Admins can review governance change history/],
      ['/data-lifecycle', 'Data Requests', /Only Owners and Admins can review data requests/],
    ] as const) {
      await gotoWithDevServerRetry(page, route);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await expect(page.getByText(warning)).toBeVisible();
    }
  });
});
