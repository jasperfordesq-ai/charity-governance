import path from 'node:path';
import { test, expect } from '../fixtures';
import { IS_DEPLOYED_QA } from '../env';
import { gotoWithDevServerRetry } from '../helpers/navigation';

const SAMPLE_FILE = path.resolve(__dirname, '../fixtures/sample-document.txt');

test.describe('Document control refresh concurrency', () => {
  test.skip(IS_DEPLOYED_QA, 'Controlled response delay requires the origin-fenced disposable environment.');

  test('a second owner review survives the previous save background refresh', async ({ ownerPage, browserOriginFence }) => {
    const ids: string[] = [];
    await gotoWithDevServerRetry(ownerPage, '/documents');
    for (let index = 0; index < 2; index += 1) {
      const name = `E2E sequential custody ${index} ${Date.now()}`;
      await ownerPage.getByRole('button', { name: 'Upload Document' }).click();
      await ownerPage.getByLabel('Document Name').fill(name);
      await ownerPage.locator('#document-upload-file').setInputFiles(SAMPLE_FILE);
      const uploaded = ownerPage.waitForResponse(response =>
        /\/api\/v1\/documents$/.test(response.url()) && response.request().method() === 'POST');
      await ownerPage.getByRole('button', { name: 'Upload', exact: true }).click();
      const response = await uploaded;
      expect(response.status()).toBe(201);
      const id: string = (await response.json()).data.id;
      ids.push(id);
      await expect(ownerPage.getByRole('article').filter({ hasText: id })).toBeVisible();
    }

    let releaseMirror!: () => void;
    const deliverMirror = new Promise<void>(resolve => { releaseMirror = resolve; });
    let mirrorHeld = false;
    const mirrorRoute = `${browserOriginFence.apiOrigin}/api/v1/documents/confluence-mirrors?*`;
    await ownerPage.route(mirrorRoute, async route => {
      if (mirrorHeld) return route.fallback();
      expect(route.request().method()).toBe('GET');
      mirrorHeld = true;
      const response = await route.fetch({ maxRedirects: 0 });
      expect(response.status()).toBe(200);
      await deliverMirror;
      await route.fulfill({ response });
    });

    try {
      const firstRow = ownerPage.getByRole('article').filter({ hasText: ids[0] });
      await firstRow.getByRole('button', { name: /^Change owner for / }).click();
      await ownerPage.getByLabel('Accountable owner', { exact: true }).fill('First custodian');
      const firstSave = ownerPage.waitForResponse(response =>
        response.url().endsWith(`/api/v1/documents/${ids[0]}`) && response.request().method() === 'PATCH');
      await ownerPage.getByRole('button', { name: 'Save owner', exact: true }).click();
      expect((await firstSave).status()).toBe(200);
      await expect(firstRow.locator('dl')).toContainText('First custodian');
      await expect.poll(() => mirrorHeld).toBe(true);
      await expect(ownerPage.getByRole('dialog')).toHaveCount(0);

      const secondRow = ownerPage.getByRole('article').filter({ hasText: ids[1] });
      await secondRow.getByRole('button', { name: /^Change owner for / }).click();
      await ownerPage.getByLabel('Accountable owner', { exact: true }).fill('Second custodian');
      releaseMirror();
      await expect(ownerPage.getByRole('dialog')).toBeVisible();
      await expect(ownerPage.getByLabel('Accountable owner', { exact: true })).toHaveValue('Second custodian');
      await expect(ownerPage.getByRole('button', { name: 'Save owner', exact: true })).toBeEnabled();
      const secondSave = ownerPage.waitForResponse(response =>
        response.url().endsWith(`/api/v1/documents/${ids[1]}`) && response.request().method() === 'PATCH');
      await ownerPage.getByRole('button', { name: 'Save owner', exact: true }).click();
      const response = await secondSave;
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON()).toMatchObject({
        owner: 'Second custodian', expectedUpdatedAt: expect.any(String),
      });
      await expect(secondRow.locator('dl')).toContainText('Second custodian');
      await expect(firstRow.locator('dl')).toContainText('First custodian');
    } finally {
      releaseMirror();
      await ownerPage.unroute(mirrorRoute);
    }
  });

});
