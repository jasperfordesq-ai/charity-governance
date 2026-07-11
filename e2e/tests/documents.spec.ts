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
});
