import type { Page } from '@playwright/test';
import { expect, reliableFill } from '../fixtures';

/** Caller must already be on Documents in the runner-owned disposable charity. */
export async function approveSyntheticDraftRecoveryPolicy(page: Page): Promise<string> {
  const panel = page.getByRole('region', { name: 'Draft retention policies' });
  await reliableFill(panel.getByLabel('Recovery days after removal'), '30');
  await panel.getByRole('button', { name: 'Review approval' }).click();
  await reliableFill(page.getByLabel('Policy approval evidence reference'), `SYNTHETIC-POLICY-${Date.now()}`);
  await page.getByRole('checkbox', { name: /I have authority to approve these exact terms/ }).check();
  const response = page.waitForResponse(item => item.url().endsWith('/documents/policy-revisions') && item.request().method() === 'POST');
  await page.getByRole('button', { name: 'Approve and replace earlier approvals' }).click();
  const result = await response;
  expect(result.status()).toBe(201);
  return (await result.json()).data.id as string;
}
