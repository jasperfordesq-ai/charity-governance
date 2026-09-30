import { expect, type Page } from '@playwright/test';
import { gotoWithDevServerRetry } from './navigation';

export async function reviewLifecycleAudit(page: Page, family: 'Document' | 'Complaint') {
  const slug = family.toLowerCase();
  const responses = ['retention-policies', 'retention-withdrawals', `${slug}-purge-reviews`, `${slug}-purge-withdrawals`, `${slug}-purge-claims`, `${slug}-copy-authorities`, `${slug}-copy-holds`, `${slug}-copy-evidence`]
    .map(feed => page.waitForResponse(response => response.url().endsWith(`/governance-audit/${feed}`) && response.request().method() === 'GET'));
  await gotoWithDevServerRetry(page, '/governance-audit');
  for (const response of await Promise.all(responses)) {
    expect(response.status()).toBe(200);
    const payload = await response.json();
    expect(payload.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(payload)).not.toMatch(/SYNTHETIC-|scopeRef|evidenceRef|storagePath|transactionId|dispositionPlan/);
  }
  const section = (name: string) => page.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(section(`${family} disposal authority withdrawals`)).toContainText('Disposal authority withdrawn');
  await expect(section(`${family} primary disposal claims`)).toContainText(family === 'Document' ? 'Primary disposal claimed; check storage receipt' : 'Primary complaint disposal claimed');
  await expect(section(`${family} copy authority decisions`)).toContainText('Copy authority withdrawn');
  await expect(section(`${family} copy observations`)).toContainText('Copy observation: verified absent');
}
