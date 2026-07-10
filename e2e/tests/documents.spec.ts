import path from 'node:path';
import { test, expect } from '../fixtures';
import { withDb } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';

/**
 * Journey: upload a document, then download it back and verify the bytes.
 *
 * Local storage driver streams downloads via GET /documents/:id/download (which
 * returns a /documents/_local-download?path=... URL). The download control opens
 * that URL in a new tab (window.open), so we assert the download deterministically
 * with authenticated in-page fetches. Those requests remain inside the mandatory
 * BrowserContext origin fence; APIRequestContext would bypass it.
 */
const SAMPLE_FILE = path.resolve(__dirname, '../fixtures/sample-document.txt');
const SAMPLE_MARKER = 'CharityPilot E2E sample document';

test.describe('Documents', () => {
  test('upload a document then download it', async ({ ownerPage, owner, browserOriginFence }) => {
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

    // Resolve the document id and exercise the download path with the session.
    const docId = await withDb(async (client) => {
      const res = await client.query(
        `SELECT "id" FROM "Document" WHERE "organisationId" = $1 AND "name" = $2`,
        [owner.organisationId, docName],
      );
      return res.rows[0]?.id as string | undefined;
    });
    expect(docId, 'uploaded document should exist in the DB').toBeTruthy();

    const linkResp = await ownerPage.evaluate(async ({ apiOrigin, documentId }) => {
      const response = await fetch(`${apiOrigin}/api/v1/documents/${documentId}/download`, {
        credentials: 'include',
      });
      return {
        ok: response.ok,
        status: response.status,
        responseUrl: response.url,
        body: (await response.json()) as { url?: string },
      };
    }, { apiOrigin: browserOriginFence.apiOrigin, documentId: docId });
    expect(linkResp.ok, `download link returned HTTP ${linkResp.status}`).toBeTruthy();
    expect(new URL(linkResp.responseUrl).origin).toBe(browserOriginFence.apiOrigin);
    const { url } = linkResp.body;
    expect(url).toBeTruthy();
    expect(url).toContain('/documents/_local-download');

    const fileResp = await ownerPage.evaluate(async ({ apiOrigin, downloadUrl }) => {
      const response = await fetch(new URL(downloadUrl, apiOrigin), { credentials: 'include' });
      return {
        ok: response.ok,
        status: response.status,
        responseUrl: response.url,
        body: await response.text(),
      };
    }, { apiOrigin: browserOriginFence.apiOrigin, downloadUrl: url! });
    expect(fileResp.ok, `document download returned HTTP ${fileResp.status}`).toBeTruthy();
    expect(new URL(fileResp.responseUrl).origin).toBe(browserOriginFence.apiOrigin);
    expect(fileResp.body).toContain(SAMPLE_MARKER);
  });
});
