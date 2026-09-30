import { expect, type Locator } from '@playwright/test';

export async function reviewCopyPreservation(copies: Locator) {
  const panel = copies.getByRole('region', { name: 'Scoped copy preservation' });
  await panel.getByRole('button', { name: 'Load preservation history', exact: true }).click();
  const record = panel.getByRole('button', { name: 'Record copy preservation hold', exact: true });
  await expect(record).toBeDisabled();
  await panel.getByLabel('Copy hold evidence reference', { exact: true }).fill('SYNTHETIC-HOLD-001');
  await panel.getByLabel('Reason for copy preservation decision', { exact: true }).fill('Preserve this synthetic scope pending separate review.');
  await expect(record).toBeDisabled();
  await panel.getByRole('checkbox').check();
  await record.click();
  await expect(panel.getByRole('status')).toHaveText('Preservation hold recorded for this exact scope.');
  await panel.getByRole('button', { name: 'Load preservation history', exact: true }).click();
  await expect(panel).toContainText('Revision 1: Hold recorded');
  await panel.getByLabel('Copy hold evidence reference', { exact: true }).fill('SYNTHETIC-HOLD-RELEASE-002');
  await panel.getByLabel('Reason for copy preservation decision', { exact: true }).fill('Reviewed synthetic evidence permits release of this hold.');
  await panel.getByRole('checkbox').check();
  // A changed review must require confirmation again.
  await panel.getByLabel('Copy hold evidence reference', { exact: true }).fill('SYNTHETIC-HOLD-RELEASE-003');
  const release = panel.getByRole('button', { name: 'Record copy hold release', exact: true });
  await expect(release).toBeDisabled();
  await panel.getByRole('checkbox').check();
  await release.click();
  await expect(panel.getByRole('status')).toHaveText('Hold release recorded. New copy authority still requires separate review.');
  await panel.getByRole('button', { name: 'Load preservation history', exact: true }).click();
  await expect(panel).toContainText('Revision 2: Hold released');
  await expect(panel).toContainText('Revision 1: Hold recorded');
}
