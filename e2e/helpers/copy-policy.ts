import { expect, type Page } from '@playwright/test';

export async function reviewCopyPolicy(page: Page, family: 'Document' | 'Complaint', keepApproved = false) {
  const section = page.getByRole('region', { name: `${family} copy retention policies`, exact: true });
  await expect(section).toContainText('Recorded recovery days do not provide recovery of external copies');
  await expect(section.getByRole('button', { name: 'Save proposal', exact: true })).toBeDisabled();
  await section.getByLabel('Recorded recovery period (days)', { exact: true }).fill('14');
  await section.getByRole('button', { name: 'Save proposal', exact: true }).click();
  await expect(section.getByRole('status')).toContainText('Proposal recorded');
  await section.getByRole('button', { name: 'Load policy history', exact: true }).click();
  await expect(section).toContainText('Revision 1: Proposal');
  await section.getByRole('button', { name: 'Review approval', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('It does not approve disposal');
  await dialog.getByLabel('Policy approval evidence reference', { exact: true }).fill('SYNTHETIC-COPY-POLICY-001');
  const approve = dialog.getByRole('button', { name: 'Approve and replace earlier approvals', exact: true });
  await expect(approve).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await approve.click();
  await expect(section.getByRole('status')).toContainText('Copy policy approved');
  await section.getByRole('button', { name: 'Load policy history', exact: true }).click();
  await expect(section).toContainText('Revision 2: Approved');
  await section.getByRole('button', { name: 'Review withdrawal', exact: true }).click();
  await dialog.getByLabel('Withdrawal evidence reference', { exact: true }).fill('SYNTHETIC-COPY-POLICY-WITHDRAWAL');
  await dialog.getByLabel('Reason for policy withdrawal', { exact: true }).fill('Withdraw synthetic copy terms after this isolated review.');
  await dialog.getByRole('button', { name: 'Withdraw policy', exact: true }).click();
  await expect(section.getByRole('status')).toContainText('Policy withdrawn');
  await section.getByRole('button', { name: 'Load policy history', exact: true }).click();
  await expect(section).toContainText('Revision 2: Withdrawn');
  await expect(section).toContainText('Revision 1: Proposal');
  if (keepApproved) {
    await section.getByRole('button', { name: 'Review approval', exact: true }).click();
    await dialog.getByLabel('Policy approval evidence reference', { exact: true }).fill('SYNTHETIC-COPY-POLICY-003');
    await dialog.getByRole('checkbox').check();
    await approve.click();
    await expect(section.getByRole('status')).toContainText('Copy policy approved');
  }
}
