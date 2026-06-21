import { test, expect } from '../fixtures';
import { getPrincipleIdByNumber, getSignoff, countRows } from '../helpers/db';

/**
 * Journey: record a governance standard's compliance status (auto-saved), then
 * complete board sign-off. The principle detail page auto-saves each field
 * (debounced PUT /compliance/records/:standardId); sign-off lives on /export.
 * We edit the FIRST (core) standard of Principle 1, which is always available
 * on the trial/Essentials plan.
 */
const YEAR = new Date().getFullYear();

test.describe('Compliance', () => {
  test('record a standard then complete board sign-off', async ({ ownerPage, owner }) => {
    // Jump straight to Principle 1's detail page (principleId is a non-stable cuid).
    const principleId = await getPrincipleIdByNumber(1);
    await ownerPage.goto(`/compliance/${principleId}`);
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
    await ownerPage.goto('/export');
    await ownerPage.getByRole('button', { name: 'Approval status' }).click();
    await ownerPage.getByRole('option', { name: 'Approved by board' }).click();
    await ownerPage.getByLabel('Board meeting date').fill(`${YEAR}-05-20`);
    await ownerPage.getByLabel('Minute reference').fill(`Board minutes 20 May ${YEAR}, item 6`);
    await ownerPage.getByRole('textbox', { name: 'Approved by', exact: true }).fill('Jane Chairperson');

    const signoffPut = ownerPage.waitForResponse(
      (r) => /\/compliance\/signoff/.test(r.url()) && r.request().method() === 'PUT',
    );
    await ownerPage.getByRole('button', { name: 'Save sign-off' }).click();
    const signoffResp = await signoffPut;
    expect(signoffResp.status()).toBe(200);

    // Persisted as APPROVED with an approver and an approvedAt timestamp.
    const signoff = await getSignoff(owner.organisationId, YEAR);
    expect(signoff?.status).toBe('APPROVED');
    expect(signoff?.approvedByName).toBe('Jane Chairperson');
    expect(signoff?.approvedAt).toBeTruthy();
  });
});
