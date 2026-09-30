import { expect, type Locator, type Page } from '@playwright/test';
import { withDb } from './db';

export async function reviewCopyAuthority(page: Page, copies: Locator, latestReference: string) {
  await copies.getByRole('listitem').filter({ hasText: latestReference }).getByRole('button', { name: 'Record a later observation' }).click();
  const authority = copies.getByRole('region', { name: 'Scoped copy authority', exact: true });
  await authority.getByRole('button', { name: 'Load copy authority review', exact: true }).click();
  await expect(authority).toContainText('Current copy policy: revision 3');
  await authority.getByLabel('Reviewed copy decision', { exact: true }).selectOption('DISPOSE');
  await authority.getByLabel('Copy authority evidence reference', { exact: true }).fill('SYNTHETIC-COPY-AUTHORITY-001');
  await authority.getByLabel('Reason for copy authority decision', { exact: true }).fill('Reviewed synthetic copy is eligible for scoped disposal.');
  await authority.getByLabel('Copy retention review reference', { exact: true }).fill('SYNTHETIC-RETENTION-001');
  await authority.getByLabel('Copy hold review reference', { exact: true }).fill('SYNTHETIC-HOLD-REVIEW-001');
  const localTime = async (offset: number) => {
    const clock = await withDb(client => client.query(`SELECT to_char(timezone('UTC',clock_timestamp()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`));
    return page.evaluate(({ now, offset }) => {
      const date = new Date(new Date(now).getTime() + offset);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
    }, { now: clock.rows[0].now as string, offset });
  };
  await authority.getByLabel('Copy authority expiry', { exact: true }).fill(await localTime(86400000));
  const record = authority.getByRole('button', { name: 'Record scoped copy authority', exact: true });
  await expect(record).toBeDisabled();
  await authority.getByRole('checkbox').check();
  await record.click();
  await expect(authority.getByRole('status')).toContainText('Copy authority recorded');
  await authority.getByRole('button', { name: 'Load copy authority review', exact: true }).click();
  await authority.getByRole('button', { name: 'Use current copy authority for observation', exact: true }).click();
  await expect(copies).toContainText('Observation will cite copy authority revision 1');
  await copies.getByLabel('Reviewed copy outcome', { exact: true }).selectOption('VERIFIED_ABSENT');
  await copies.getByLabel('Copy observation evidence reference', { exact: true }).fill('SYNTHETIC-BOUND-ABSENCE-003');
  await copies.getByLabel('Reason for copy observation', { exact: true }).fill('Reviewed synthetic evidence establishes absence of this exact scope.');
  await copies.getByLabel('Copy observation time', { exact: true }).fill(await localTime(0));
  await copies.getByRole('checkbox', { name: 'I reviewed the evidence for this exact scope and outcome.', exact: true }).check();
  await copies.getByRole('button', { name: 'Record copy observation', exact: true }).click();
  const observation = copies.getByRole('listitem').filter({ hasText: 'SYNTHETIC-BOUND-ABSENCE-003' });
  await expect(observation).toContainText('Revision 3');
  await expect(observation).toContainText('Absence verified by reviewer');
  await observation.getByRole('button', { name: 'Record a later observation' }).click();
  await authority.getByRole('button', { name: 'Load copy authority review', exact: true }).click();
  await authority.getByLabel('Copy authority evidence reference', { exact: true }).fill('SYNTHETIC-AUTHORITY-WITHDRAWAL-002');
  await authority.getByLabel('Reason for copy authority decision', { exact: true }).fill('Withdraw synthetic authority after the bounded review.');
  await authority.getByRole('checkbox').check();
  await authority.getByRole('button', { name: 'Withdraw scoped copy authority', exact: true }).click();
  await expect(authority.getByRole('status')).toContainText('Copy authority withdrawn');
  await authority.getByRole('button', { name: 'Load copy authority review', exact: true }).click();
  await expect(authority).toContainText('Authority revision 2: WITHDRAWN');
  await expect(authority.getByRole('button', { name: 'Use current copy authority for observation', exact: true })).toHaveCount(0);
}
