import { test, expect } from '../fixtures';
import { withDb } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

const year = new Date().getFullYear();

test.describe('DPO minimised export', () => {
  test('a recorded synthetic Board approval exposes the minimised draft without internal narrative', async ({ owner, ownerPage }) => {
    test.setTimeout(120_000);
    const marker = Date.now();
    const privateAction = `SYNTHETIC_INTERNAL_ACTION_${marker}`;
    const privateEvidence = `SYNTHETIC_INTERNAL_EVIDENCE_${marker}`;
    const privateMinute = `SYNTHETIC_PRIVATE_MINUTE_${marker}`;
    const privateApprover = `SYNTHETIC_PRIVATE_APPROVER_${marker}`;

    // Only this disposable charity is seeded. Every applicable core standard
    // has a real persisted status and evidence, so the application itself
    // decides that its normal approval-readiness gate has been met.
    await withDb(async (client) => {
      await client.query(
        `UPDATE "Organisation" SET "complexity" = 'SIMPLE',
           "conditionalObligationProfile" = $2::jsonb WHERE "id" = $1`,
        [owner.organisationId, JSON.stringify({
          hasPaidStaff: false, hasVolunteers: false, raisesFundsFromPublic: false,
          worksWithChildrenOrVulnerableAdults: false, processesPersonalData: true,
          operatesPremisesOrEvents: false, isPublicSectorBody: false, usesDataProcessors: false,
        })],
      );
      await client.query(
        `INSERT INTO "ComplianceRecord"
          ("id", "organisationId", "standardId", "reportingYear", "status",
           "actionTaken", "evidence", "revision", "createdAt", "updatedAt")
         SELECT 'dpo-export-' || $3::text || '-' || "id", $1, "id", $2,
           'COMPLIANT', $4, $5, 1, NOW(), NOW()
         FROM "GovernanceStandard" WHERE "isCore" = true`,
        [owner.organisationId, year, marker, privateAction, privateEvidence],
      );
    });

    await gotoWithDevServerRetry(ownerPage, '/export');
    const status = ownerPage.getByRole('button', { name: /Approval status/ }).last();
    const approvedOption = ownerPage.getByRole('option', { name: 'Approved by board', exact: true });
    await expect(async () => {
      if (!(await approvedOption.isVisible().catch(() => false))) await status.click();
      await approvedOption.click({ timeout: 2_000 });
      await expect(status).toContainText('Approved by board', { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await ownerPage.getByLabel('Board meeting date').fill(`${year}-05-20`);
    await ownerPage.getByLabel('Minute reference').fill(privateMinute);
    await ownerPage.getByRole('textbox', { name: 'Approved by', exact: true }).fill(privateApprover);
    const save = ownerPage.getByRole('button', { name: 'Save sign-off' });
    await expect(save).toBeEnabled();
    const approval = ownerPage.waitForResponse((response) =>
      response.url().endsWith('/api/v1/compliance/signoff') && response.request().method() === 'PUT');
    await save.click();
    expect((await approval).status()).toBe(200);

    const snapshots = await withDb((client) => client.query<{ id: string; snapshotHash: string }>(
      `SELECT "id", "snapshotHash" FROM "ComplianceApprovalSnapshot"
       WHERE "organisationId" = $1 AND "reportingYear" = $2`,
      [owner.organisationId, year],
    ));
    expect(snapshots.rows).toHaveLength(1);
    expect(snapshots.rows[0]?.snapshotHash).toMatch(/^[a-f0-9]{64}$/);

    const fullButton = ownerPage.getByRole('button', { name: 'Open full internal approved snapshot' });
    await expect(fullButton).toBeVisible();
    const fullResponse = ownerPage.waitForResponse((response) =>
      response.url().includes('/api/v1/export/compliance-report')
      && response.url().includes('version=approved')
      && response.url().includes('audience=internal'));
    await fullButton.click();
    const full = await fullResponse;
    expect(full.status()).toBe(200);
    const fullHtml = await full.text();
    for (const value of [privateAction, privateEvidence, privateMinute, privateApprover]) {
      expect(fullHtml).toContain(value);
    }

    const minimisedButton = ownerPage.getByRole('button', { name: 'Open minimised draft for audience review' });
    await expect(minimisedButton).toBeVisible();
    const minimisedResponse = ownerPage.waitForResponse((response) =>
      response.url().includes('/api/v1/export/compliance-report')
      && response.url().includes('version=approved')
      && response.url().includes('audience=minimised'));
    await minimisedButton.click();
    const minimised = await minimisedResponse;
    expect(minimised.status()).toBe(200);
    expect(minimised.headers()['cache-control']).toBe('no-store');
    const html = await minimised.text();
    expect(html).toContain('Minimised Compliance Record draft');
    expect(html).toContain('Aggregate standard statuses');
    for (const value of [privateAction, privateEvidence, privateMinute, privateApprover,
      'Snapshot SHA-256', 'Trustee Register', 'Conflicts Register']) {
      expect(html).not.toContain(value);
    }
  });
});
