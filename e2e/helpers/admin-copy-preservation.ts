import { expect, type BrowserContext, type BrowserContextOptions } from '@playwright/test';
import { createVerifiedAdmin, createAuthenticatedStorageState } from './db';
import { gotoWithDevServerRetry } from './navigation';

export async function adminCopyPreservation(organisationId: string, kind: 'document' | 'complaint', newContext: (options?: BrowserContextOptions) => Promise<BrowserContext>) {
  const admin = await createVerifiedAdmin({ organisationId, email: `copy-admin-${kind}-${Date.now()}@example.test`, name: 'Synthetic Preservation Admin' });
  const context = await newContext({ storageState: await createAuthenticatedStorageState(admin) });
  try {
    const page = await context.newPage();
    await gotoWithDevServerRetry(page, kind === 'document' ? '/documents' : '/registers');
    const panel = page.getByRole('region', { name: 'Copy preservation administration', exact: true });
    await panel.getByRole('button', { name: 'Load claimed disposal reviews', exact: true }).click();
    await panel.getByRole('button', { name: /^Review copies for / }).first().click();
    await panel.getByRole('button', { name: /^Preserve BACKUPS/ }).click();
    const hold = panel.getByRole('region', { name: 'Scoped copy preservation', exact: true });
    await hold.getByRole('button', { name: 'Load preservation history', exact: true }).click();
    await hold.getByLabel('Copy hold evidence reference', { exact: true }).fill('SYNTHETIC-ADMIN-HOLD');
    await hold.getByLabel('Reason for copy preservation decision', { exact: true }).fill('Administrator preserves this synthetic copy for further review.');
    await hold.getByRole('checkbox').check();
    await hold.getByRole('button', { name: 'Record copy preservation hold', exact: true }).click();
    await expect(hold.getByRole('status')).toContainText('Preservation hold recorded');
    await hold.getByRole('button', { name: 'Load preservation history', exact: true }).click();
    await expect(hold).toContainText('SYNTHETIC-ADMIN-HOLD');
    await expect(page.getByRole('button', { name: 'Record scoped copy authority', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Review approval', exact: true })).toHaveCount(0);
  } finally { await context.close(); }
}
