import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { test, expect } from '../fixtures';
import { gotoWithDevServerRetry } from '../helpers/navigation';

/**
 * Journey: upload a document, then download it back and verify the bytes.
 *
 * The real Download control fetches authenticated bytes from
 * GET /documents/:id/download, builds a short-lived browser object URL, and
 * triggers an attachment without opening a popup or exposing provider storage.
 * This click journey runs in every configured deployed-QA browser, including
 * WebKit/Desktop Safari.
 */
const SAMPLE_FILE = path.resolve(__dirname, '../fixtures/sample-document.txt');
const SAMPLE_MARKER = 'CharityPilot E2E sample document';

test.describe('Documents', () => {
  test('an owner can assign and clear the accountable owner of historical evidence', async ({ ownerPage }) => {
    const docName = `E2E Historical custody ${Date.now()}`;
    await gotoWithDevServerRetry(ownerPage, '/documents');
    await ownerPage.getByRole('button', { name: 'Upload Document' }).click();
    await ownerPage.getByLabel('Document Name').fill(docName);
    await ownerPage.locator('#document-upload-file').setInputFiles(SAMPLE_FILE);
    const uploaded = ownerPage.waitForResponse(r => /\/api\/v1\/documents$/.test(r.url()) && r.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Upload', exact: true }).click();
    const documentId = (await (await uploaded).json()).data.id;
    const row = ownerPage.getByRole('article').filter({ hasText: documentId });
    await row.getByRole('button', { name: `Classify ${docName}`, exact: true }).click();
    await ownerPage.getByLabel('New lifecycle status', { exact: true }).selectOption('HISTORICAL');
    await ownerPage.getByLabel('Reason for this decision').fill('Synthetic retained evidence for accountable-owner review.');
    await ownerPage.getByRole('button', { name: 'Save status', exact: true }).click();
    await expect(ownerPage.getByRole('dialog')).toHaveCount(0);
    await expect(row).toContainText('HISTORICAL');

    for (const owner of ['Company Secretary', '']) {
      await row.getByRole('button', { name: `Change owner for ${docName}`, exact: true }).click();
      await ownerPage.getByLabel('Accountable owner', { exact: true }).fill(owner);
      const saved = ownerPage.waitForResponse(r => r.url().endsWith(`/api/v1/documents/${documentId}`) && r.request().method() === 'PATCH');
      await ownerPage.getByRole('button', { name: 'Save owner', exact: true }).click();
      const response = await saved;
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON()).toMatchObject({ owner: owner || null, expectedUpdatedAt: expect.any(String) });
      const data = (await response.json()).data;
      expect(data).toMatchObject({ owner: owner || null, lifecycleStatus: 'HISTORICAL', visibility: 'RESTRICTED', contentAccessClass: 'UNASSESSED' });
      await expect(ownerPage.getByRole('dialog')).toHaveCount(0);
      await expect(row.locator('dl')).toContainText(owner || 'Unassigned');
    }
    const history = ownerPage.waitForResponse(r => r.url().endsWith('/api/v1/documents/control-audit'));
    await ownerPage.getByRole('button', { name: 'Load history', exact: true }).click();
    const events = (await (await history).json()).data.filter((event: { documentId: string; kind: string }) => event.documentId === documentId && event.kind === 'METADATA');
    expect(events).toHaveLength(2);
    expect(events.every((event: { reason: string }) => event.reason === 'Metadata edit applied to fields: owner.')).toBe(true);
  });

  test('upload a document then download it', async ({ ownerPage, browserOriginFence }) => {
    const docName = `E2E Upload ${Date.now()}`;

    await gotoWithDevServerRetry(ownerPage, '/documents');
    await ownerPage.getByRole('button', { name: 'Upload Document' }).click();

    // Fill the modal: name + attach the .txt (category defaults to OTHER).
    await ownerPage.getByLabel('Document Name').fill(docName);
    await ownerPage.locator('#document-upload-file').setInputFiles(SAMPLE_FILE);

    const uploadPost = ownerPage.waitForResponse(
      (r) => /\/api\/v1\/documents$/.test(r.url()) && r.request().method() === 'POST',
    );
    await ownerPage.getByRole('button', { name: 'Upload', exact: true }).click();
    const uploadResp = await uploadPost;
    expect(uploadResp.status()).toBe(201);

    // The new document appears in the vault list.
    await expect(ownerPage.getByText(docName)).toBeVisible();

    const documentRow = ownerPage.getByRole('article').filter({ hasText: docName });
    const pageCountBefore = ownerPage.context().pages().length;
    const responsePromise = ownerPage.waitForResponse(
      (response) =>
        /\/api\/v1\/documents\/[^/]+\/download$/.test(response.url()) &&
        response.request().method() === 'GET' &&
        response.status() === 200,
    );
    const downloadPromise = ownerPage.waitForEvent('download');

    await documentRow.getByRole('button', { name: `Download ${docName}`, exact: true }).click();
    const [downloadResponse, download] = await Promise.all([responsePromise, downloadPromise]);

    expect(downloadResponse.status()).toBe(200);
    expect(new URL(downloadResponse.url()).origin).toBe(browserOriginFence.apiOrigin);
    expect(downloadResponse.headers()['cache-control']).toBe('private, no-store, max-age=0');
    expect(ownerPage.context().pages()).toHaveLength(pageCountBefore);
    expect(download.suggestedFilename()).toBe(`${docName}.txt`);

    const downloadedPath = await download.path();
    expect(downloadedPath, 'browser download should have a local artifact').toBeTruthy();
    const downloadedBytes = await readFile(downloadedPath!);
    expect(downloadedBytes.toString('utf8')).toContain(SAMPLE_MARKER);
  });

  // HeroUI's hidden native <select> hands its change handler a raw string, which
  // the selection state iterates character by character: choosing STRATEGIC_PLAN
  // there once stored the key "S", so the select fell back to empty and the
  // upload carried an invalid category. Browser autofill and automation drive
  // that native element; people drive the listbox. Both must reach the payload.
  for (const via of ['native select', 'listbox'] as const) {
    test(`a category chosen through the ${via} stays set and is uploaded`, async ({ ownerPage }) => {
      const docName = `E2E Category ${via} ${Date.now()}`;

      await gotoWithDevServerRetry(ownerPage, '/documents');
      await ownerPage.getByRole('button', { name: 'Upload Document' }).click();
      const dialog = ownerPage.getByRole('dialog');
      await dialog.getByLabel('Document Name').fill(docName);

      const nativeSelect = dialog.locator('select');
      if (via === 'native select') {
        // Its leading blank <option> is not a category and must not clear one.
        await nativeSelect.selectOption('', { force: true });
        await expect(nativeSelect).toHaveValue('OTHER');
        await nativeSelect.selectOption('STRATEGIC_PLAN', { force: true });
      } else {
        const trigger = dialog.getByRole('button', { name: /Category/ });
        // Located by CSS, not role: inside this modal the open listbox sits under
        // an aria-hidden ancestor, so getByRole('option') never matches it.
        const option = ownerPage.locator('[role="option"]', { hasText: /^Strategic Plan$/ });
        // Only the interaction is retried, never the outcome. In CI the open
        // popover sometimes closes on its own moments after opening (react-aria
        // closes it when the modal body scrolls, and a late layout shift can
        // scroll it), detaching the option under a pointer click or a
        // typeahead alike. Reopening and choosing again is what a person does;
        // the value must still land in the Select and reach the upload below.
        await expect(async () => {
          if (!(await option.isVisible())) await trigger.click();
          await option.click({ timeout: 3_000 });
          await expect(nativeSelect).toHaveValue('STRATEGIC_PLAN', { timeout: 1_000 });
        }).toPass({ timeout: 30_000 });
      }
      await expect(nativeSelect).toHaveValue('STRATEGIC_PLAN');
      await expect(dialog.getByRole('button', { name: /Category/ })).toContainText('Strategic Plan');

      await dialog.locator('#document-upload-file').setInputFiles(SAMPLE_FILE);
      const uploadPost = ownerPage.waitForResponse(
        (r) => /\/api\/v1\/documents$/.test(r.url()) && r.request().method() === 'POST',
      );
      await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
      const uploadResp = await uploadPost;

      expect(uploadResp.request().postData() ?? '').toMatch(/name="category"\r\n\r\nSTRATEGIC_PLAN\r\n/);
      expect(uploadResp.status()).toBe(201);
      expect((await uploadResp.json()).data.category).toBe('STRATEGIC_PLAN');
    });
  }
});
