import path from 'node:path';
import { test, expect } from '../fixtures';
import { API_BASE_URL, WEB_BASE_URL } from '../playwright.config';
import { withDb } from '../helpers/db';

/**
 * Journey: upload a document, then download it back and verify the bytes.
 *
 * Local storage driver streams downloads via GET /documents/:id/download (which
 * returns a /documents/_local-download?path=... URL). The download control opens
 * that URL in a new tab (window.open), so we assert the download deterministically
 * with the page's authenticated request context rather than a browser download.
 */
const SAMPLE_FILE = path.resolve(__dirname, '../fixtures/sample-document.txt');
const SAMPLE_MARKER = 'CharityPilot E2E sample document';

test.describe('Documents', () => {
  test('upload a document then download it', async ({ ownerPage, owner }) => {
    const docName = `E2E Upload ${Date.now()}`;

    await ownerPage.goto('/documents');
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

    const linkResp = await ownerPage.request.get(
      `${API_BASE_URL}/api/v1/documents/${docId}/download`,
      { headers: { origin: WEB_BASE_URL } },
    );
    expect(linkResp.ok()).toBeTruthy();
    const { url } = (await linkResp.json()) as { url: string };
    expect(url).toContain('/documents/_local-download');

    const fileResp = await ownerPage.request.get(url, { headers: { origin: WEB_BASE_URL } });
    expect(fileResp.ok()).toBeTruthy();
    expect(await fileResp.text()).toContain(SAMPLE_MARKER);
  });
});
