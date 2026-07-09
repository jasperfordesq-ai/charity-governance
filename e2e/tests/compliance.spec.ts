import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { getComplianceRecord, getPrincipleIdByNumber, getSignoff, countRows } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

/**
 * Journey: record a governance standard's compliance status (auto-saved), then
 * prove the export flow blocks premature board approval while still allowing a
 * board-review sign-off. The principle detail page auto-saves each field
 * (debounced PUT /compliance/records/:standardId); sign-off lives on /export.
 * We edit the FIRST (core) standard of Principle 1, which is always available
 * on the trial/Essentials plan.
 */
const YEAR = new Date().getFullYear();

async function chooseApprovalStatus(page: Page, status: string) {
  const trigger = page.getByRole('button', { name: /Approval status/ }).last();
  await trigger.scrollIntoViewIfNeeded();
  const option = page.getByRole('option', { name: status, exact: true });
  await expect(async () => {
    await trigger.click();
    await expect(option).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 30_000 });
  await expect(option).toBeVisible();
  await option.click();
}

test.describe('Compliance', () => {
  test('record a standard then block premature approval and save board-review sign-off', async ({ ownerPage, owner }) => {
    // Jump straight to Principle 1's detail page (principleId is a non-stable cuid).
    const principleId = await getPrincipleIdByNumber(1);
    await gotoWithDevServerRetry(ownerPage, `/compliance/${principleId}`);
    await expect(ownerPage.getByRole('heading', { name: /Principle 1:/ })).toBeVisible();

    // Set the first standard's status to Compliant and record an action; wait
    // for the debounced auto-save PUT to land (no Save button on this page).
    const savePut = ownerPage.waitForResponse(
      (r) => /\/compliance\/records\//.test(r.url()) && r.request().method() === 'PUT',
    );
    await ownerPage.getByRole('button', { name: 'Status' }).first().click();
    await ownerPage.getByRole('option', { name: 'Compliant', exact: true }).click();
    await ownerPage
      .getByLabel('Action Taken')
      .first()
      .fill('Adopted a clear, board-approved statement of charitable purpose.');
    const saveResp = await savePut;
    expect(saveResp.status()).toBe(200);

    // The record persisted for this organisation + reporting year.
    const complianceRecords = await countRows(
      'ComplianceRecord',
      'WHERE "organisationId" = $1 AND "status" = $2 AND "reportingYear" = $3',
      [owner.organisationId, 'COMPLIANT', YEAR],
    );
    expect(complianceRecords).toBeGreaterThanOrEqual(1);

    // Board sign-off (on the Export page).
    await gotoWithDevServerRetry(ownerPage, '/export');
    await chooseApprovalStatus(ownerPage, 'Approved by board');
    await ownerPage.getByLabel('Board meeting date').fill(`${YEAR}-05-20`);
    await ownerPage.getByLabel('Minute reference').fill(`Board minutes 20 May ${YEAR}, item 6`);
    await ownerPage.getByRole('textbox', { name: 'Approved by', exact: true }).fill('Jane Chairperson');

    await ownerPage.getByRole('button', { name: 'Save sign-off' }).click();
    await expect(ownerPage.getByText(/Resolve Compliance Record readiness blockers before board approval/)).toBeVisible();

    await chooseApprovalStatus(ownerPage, 'Ready for board review');
    const signoffPut = ownerPage.waitForResponse(
      (r) => /\/compliance\/signoff/.test(r.url()) && r.request().method() === 'PUT',
    );
    await ownerPage.getByRole('button', { name: 'Save sign-off' }).click();
    const signoffResp = await signoffPut;
    expect(signoffResp.status()).toBe(200);

    // Persisted as BOARD_REVIEW without falsely recording approval.
    const signoff = await getSignoff(owner.organisationId, YEAR);
    expect(signoff?.status).toBe('BOARD_REVIEW');
    expect(signoff?.approvedByName).toBe('Jane Chairperson');
    expect(signoff?.approvedAt).toBeNull();
  });

  test('pending standard edits ask for confirmation before in-app navigation', async ({ ownerPage, owner }) => {
    const principleId = await getPrincipleIdByNumber(1);
    await gotoWithDevServerRetry(ownerPage, `/compliance/${principleId}`);
    await expect(ownerPage.getByRole('heading', { name: /Principle 1:/ })).toBeVisible();

    await ownerPage
      .getByLabel('Action Taken')
      .first()
      .fill(`Pending navigation guard exercised at ${Date.now()}.`);
    await ownerPage.getByRole('link', { name: 'Documents' }).click();

    const dialog = ownerPage.getByRole('dialog', { name: 'Compliance edits are still saving' });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(ownerPage).toHaveURL(new RegExp(`/compliance/${principleId}`));

    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(dialog).toBeHidden();
    await expect(ownerPage).toHaveURL(new RegExp(`/compliance/${principleId}`));

    const saveAndLeaveAction = `Pending navigation save-and-leave exercised at ${Date.now()}.`;
    await ownerPage.getByLabel('Action Taken').first().fill(saveAndLeaveAction);
    await ownerPage.getByRole('link', { name: 'Documents' }).click();
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await dialog.getByRole('button', { name: 'Save now and leave' }).click();
    await expect(ownerPage).toHaveURL(/\/documents/, { timeout: 60_000 });
    await expect.poll(async () => {
      const record = await getComplianceRecord(owner.organisationId, '1.1', YEAR);
      return record?.actionTaken ?? '';
    }, { timeout: 60_000 }).toBe(saveAndLeaveAction);
  });
});
