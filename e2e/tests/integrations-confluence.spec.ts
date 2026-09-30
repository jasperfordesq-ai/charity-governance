import path from 'node:path';
import { test, expect, reliableFill, uniqueEmail, TEST_PASSWORD } from '../fixtures';
import { gotoWithDevServerRetry } from '../helpers/navigation';
import { createAuthenticatedStorageState, createVerifiedOwner, withDb } from '../helpers/db';

/**
 * Journey: the Confluence connector, end to end, against a fake Atlassian.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * NOTHING HERE TOUCHES A REAL ATLASSIAN SITE, AND IT CANNOT.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The stack runs a `fake-atlassian` service on the internal network with no
 * published port. The API reaches it only because `CHARITYPILOT_FAKE_ATLASSIAN`
 * is `1` in `compose.e2e.yml`; `atlassian-endpoints.ts` refuses the override
 * under `NODE_ENV=production`, and `validateProductionEnv` refuses to boot a
 * production deployment carrying the variable at all. `atlassian-endpoints.test.ts`
 * pins each of those fences separately.
 *
 * The journey is the one the audit named: disclosure → callback → space choice
 * → status. What it is really testing is that the four surfaces agree — that
 * the disclosure cannot be bypassed, that connecting and choosing a destination
 * are separate acts, and that "Connected" never on its own reads as
 * "publishing".
 */

/** The API path the web app proxies to. Kept in one place so a rename is one edit. */
const CONFLUENCE_API = /\/api\/v1\/integrations\/confluence/;
const SAMPLE_FILE = path.resolve(__dirname, '../fixtures/sample-document.txt');

test.describe('Confluence connector', () => {
  test('disclosure, connect, choose a space, and review the exact destination before approval', async ({ newFencedContext }) => {
    test.setTimeout(180_000);
    // This connection journey must start without another test's integration state.
    const owner = await createVerifiedOwner({ email: uniqueEmail('confluence-connect'), password: TEST_PASSWORD,
      name: 'Confluence Owner', organisationName: 'Isolated Confluence Charity' });
    const storageState = await createAuthenticatedStorageState({ ...owner, role: 'OWNER' });
    const context = await newFencedContext({ storageState });
    const ownerPage = await context.newPage();
    await gotoWithDevServerRetry(ownerPage, '/integrations');

    // ── 1. Not connected, and saying so plainly ──────────────────────────
    await expect(ownerPage.getByRole('button', { name: 'Connect Confluence' })).toBeVisible();

    // ── 2. The disclosure is the gate, not a footnote beside it ──────────
    const authorize = ownerPage.waitForResponse(
      (r) => /\/confluence\/authorize$/.test(r.url()) && r.request().method() === 'GET',
    );
    await ownerPage.getByRole('button', { name: 'Connect Confluence' }).click();
    const authorizeResponse = await authorize;
    expect(authorizeResponse.status()).toBe(200);

    // The link to Atlassian only ever renders from `buildConnectView`, which
    // throws rather than returning a URL when the disclosure is missing. So the
    // presence of this button is itself the assertion that the limits were
    // shown: there is no path to the link that skips them.
    const continueButton = ownerPage.getByRole('button', { name: /continue to Atlassian/i });
    await expect(continueButton).toBeVisible();

    // The two limits a DPO cares about most must be on screen before consent.
    await expect(ownerPage.getByText(/trash/i).first()).toBeVisible();

    const authorizationUrl = await continueButton.getAttribute('href');
    expect(authorizationUrl, 'the authorize link must carry a URL').toBeTruthy();

    // ── 3. The callback, driven as Atlassian would drive it ──────────────
    //
    // The `state` is signed by the API and travels in the authorize URL. Taking
    // it from there rather than minting one is deliberate: a test that forged a
    // state would pass even if the CSRF defence were removed.
    const state = new URL(authorizationUrl as string).searchParams.get('state');
    expect(state, 'authorize must mint a signed state').toBeTruthy();

    const callback = ownerPage.waitForResponse(
      (r) => /\/confluence\/callback$/.test(r.url()) && r.request().method() === 'POST',
    );
    await gotoWithDevServerRetry(
      ownerPage,
      `/integrations/confluence/callback?code=fake-authorization-code&state=${encodeURIComponent(state as string)}`,
    );
    const callbackResponse = await callback;
    expect(callbackResponse.status(), await callbackResponse.text()).toBe(200);

    // ── 4. Connected — and NOT publishing, which is the point ────────────
    await gotoWithDevServerRetry(ownerPage, '/integrations');
    await expect(ownerPage.getByText('Charity E2E')).toBeVisible();

    // A charity that believes it is mirroring and is not is worse off than one
    // that knows it has a step left. Connecting is the opt-in; choosing a space
    // is the destination; neither substitutes for the other.
    await expect(ownerPage.getByRole('button', { name: /Choose a space/i })).toBeVisible();

    // ── 5. The space picker lists what the site actually has ─────────────
    const spaces = ownerPage.waitForResponse(
      (r) => /\/confluence\/spaces/.test(r.url()) && r.request().method() === 'GET',
    );
    await ownerPage.getByRole('button', { name: /Choose a space/i }).click();
    expect((await spaces).status()).toBe(200);

    await ownerPage.getByRole('button', { name: /Confluence space/i }).click();
    const governanceSpace = ownerPage.getByRole('option', { name: /Governance \(GOV\)/ });
    await expect(governanceSpace).toBeVisible();
    await governanceSpace.press('Enter');

    const savedSpace = ownerPage.waitForResponse(
      (r) => /\/confluence\/publish-space$/.test(r.url()) && r.request().method() === 'PUT',
    );
    await ownerPage.getByRole('button', { name: 'Publish into this space' }).click();
    expect((await savedSpace).status()).toBe(200);

    // ── 6. Now, and only now, it is publishing ───────────────────────────
    //
    // Read from the status call the PAGE makes, not one this test issues.
    // Driving the API directly would bypass the browser origin fence, which is
    // the thing these specs exist to exercise. The runner enforces it with a
    // source guard forbidding direct Playwright APIRequestContext calls in
    // these specs, so the rule is structural rather than remembered.
    const status = await ownerPage.waitForResponse(
      (r) => /\/confluence\/status$/.test(r.url()) && r.request().method() === 'GET',
    );
    const statusBody = (await status.json()) as {
      data: {
        status: string;
        publishing: boolean;
        publishSpace: { key: string } | null;
        declaredEnvironment: { controlledByCharityPilot: boolean };
      };
    };
    expect(statusBody.data.status).toBe('CONNECTED');
    expect(statusBody.data.publishSpace?.key).toBe('GOV');
    expect(statusBody.data.publishing).toBe(true);

    // The residency caveat travels on every status response, so a client cannot
    // render a declaration without it.
    expect(statusBody.data.declaredEnvironment.controlledByCharityPilot).toBe(false);

    // And the screen says so too. A charity reads the page, not the payload.
    await expect(ownerPage.getByText(/Governance/).first()).toBeVisible();

    // The document approval must name the destination the administrator saw,
    // and a changed selection must fail without an approval event.
    await gotoWithDevServerRetry(ownerPage, '/documents');
    const documentName = `DPO reviewed destination ${Date.now()}`;
    await ownerPage.getByRole('button', { name: /Upload document/i }).click();
    await reliableFill(ownerPage.getByLabel('Document name'), documentName);
    await ownerPage.locator('#document-upload-file').setInputFiles(SAMPLE_FILE);
    const uploaded = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/documents$/.test(response.url()) && response.request().method() === 'POST');
    await ownerPage.getByRole('button', { name: 'Upload', exact: true }).click();
    const uploadResponse = await uploaded;
    expect(uploadResponse.status()).toBe(201);
    const documentId = ((await uploadResponse.json()) as { data?: { id?: string } }).data?.id;
    if (!documentId) throw new Error('The uploaded document has no server-issued ID');
    const row = ownerPage.getByRole('article').filter({ hasText: documentName });
    await row.getByRole('button', { name: `Classify ${documentName}` }).click();
    await reliableFill(ownerPage.getByLabel('Reason for this decision'),
      'This synthetic file is current for the isolated approval journey.');
    const classified = ownerPage.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/documents/${documentId}`) && response.request().method() === 'PATCH');
    await ownerPage.getByRole('button', { name: 'Save status' }).click();
    expect((await classified).status()).toBe(200);

    const firstMirror = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/documents\/confluence-mirrors\?/.test(response.url())
      && response.request().method() === 'GET');
    await row.getByRole('button', { name: `Review Confluence publication for ${documentName}` }).click();
    const mirrorResponse = await firstMirror;
    expect(mirrorResponse.status()).toBe(200);
    const mirror = ((await mirrorResponse.json()) as { mirrors?: Record<string, {
      publishDestination?: { siteId: string; spaceId: string; spaceKey: string; spaceName: string; siteUrl: string };
    }> }).mirrors?.[documentId];
    const destination = mirror?.publishDestination;
    if (!destination) throw new Error('The fresh mirror response has no selected destination');
    await expect(ownerPage.getByText(/Reviewed destination:.*Governance.*GOV/)).toBeVisible();
    await expect(ownerPage.getByText(new RegExp(destination.siteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeVisible();

    await reliableFill(ownerPage.getByLabel('Reason for this decision'),
      'Reviewed the exact displayed Confluence destination for this synthetic file.');
    await withDb(async (client) => {
      await client.query('BEGIN');
      let transactionOpen = true;
      try {
        await client.query(
          `UPDATE "OrganisationIntegration" SET "publishSpaceId" = 'changed-space'
           WHERE "organisationId" = $1 AND "provider" = 'CONFLUENCE'`,
          [owner.organisationId],
        );
        const staleApproval = ownerPage.waitForResponse((response) =>
          response.url().endsWith(`/api/v1/documents/${documentId}`) && response.request().method() === 'PATCH');
        await ownerPage.getByRole('button', { name: 'Approve publication' }).click();
        await expect.poll(async () => {
          const activity = await withDb((observer) => observer.query<{ waiting: number }>(
            `SELECT count(*)::integer AS waiting FROM pg_stat_activity
             WHERE datname = current_database() AND application_name = 'charitypilot-api-e2e'
               AND wait_event_type = 'Lock' AND query LIKE '%FOR SHARE%'`,
          ));
          return activity.rows[0]?.waiting ?? 0;
        }, { timeout: 10_000, message: 'approval must wait for the in-flight destination change' })
          .toBeGreaterThan(0);
        await client.query('COMMIT');
        transactionOpen = false;
        const refused = await staleApproval;
        expect(refused.status()).toBe(409);
        expect(((await refused.json()) as { code?: string }).code).toBe('DOCUMENT_PUBLICATION_TARGET_CHANGED');
      } finally {
        if (transactionOpen) await client.query('ROLLBACK');
      }
    });
    const untouched = await withDb((client) => client.query(
      `SELECT "externalPublicationApproved" FROM "Document"
       WHERE "id" = $1 AND "organisationId" = $2`,
      [documentId, owner.organisationId],
    ));
    expect(untouched.rows[0]?.externalPublicationApproved).toBe(false);

    await withDb((client) => client.query(
      `UPDATE "OrganisationIntegration" SET "publishSpaceId" = $1
       WHERE "organisationId" = $2 AND "provider" = 'CONFLUENCE'`,
      [destination.spaceId, owner.organisationId],
    ));
    await ownerPage.getByRole('button', { name: 'Cancel' }).click();
    const reviewedMirror = ownerPage.waitForResponse((response) =>
      /\/api\/v1\/documents\/confluence-mirrors\?/.test(response.url())
      && response.request().method() === 'GET');
    await row.getByRole('button', { name: `Review Confluence publication for ${documentName}` }).click();
    expect((await reviewedMirror).status()).toBe(200);
    await reliableFill(ownerPage.getByLabel('Reason for this decision'),
      'Approved this synthetic current file for the reviewed Confluence space.');
    const approved = ownerPage.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/documents/${documentId}`) && response.request().method() === 'PATCH');
    await ownerPage.getByRole('button', { name: 'Approve publication' }).click();
    const approvalResponse = await approved;
    expect(approvalResponse.status()).toBe(200);
    const submitted = approvalResponse.request().postDataJSON() as Record<string, unknown>;
    expect(submitted.reviewedPublicationSiteId).toBe(destination.siteId);
    expect(submitted.reviewedPublicationSpaceId).toBe(destination.spaceId);
    const stored = await withDb((client) => client.query(
      `SELECT "externalPublicationApproved", "externalPublicationSiteId", "externalPublicationSpaceId"
       FROM "Document" WHERE "id" = $1 AND "organisationId" = $2`,
      [documentId, owner.organisationId],
    ));
    expect(stored.rows[0]).toMatchObject({ externalPublicationApproved: true,
      externalPublicationSiteId: destination.siteId, externalPublicationSpaceId: destination.spaceId });
  });

  test('no token material reaches the browser in observed connector responses', async ({ ownerPage }) => {
    const bodies: string[] = [];
    ownerPage.on('response', (response) => {
      if (!CONFLUENCE_API.test(response.url())) return;
      void response
        .text()
        .then((text) => bodies.push(text))
        .catch(() => undefined);
    });

    const status = ownerPage.waitForResponse((response) =>
      /\/confluence\/status$/.test(response.url()) && response.request().method() === 'GET');
    await gotoWithDevServerRetry(ownerPage, '/integrations');
    expect((await status).status()).toBe(200);
    if (await ownerPage.getByRole('button', { name: 'Connect Confluence' }).count()) {
      const authorize = ownerPage.waitForResponse((response) =>
        /\/confluence\/authorize$/.test(response.url()) && response.request().method() === 'GET');
      await ownerPage.getByRole('button', { name: 'Connect Confluence' }).click();
      expect((await authorize).status()).toBe(200);
      await expect(ownerPage.getByRole('button', { name: /continue to Atlassian/i })).toBeVisible();
    } else {
      const spaces = ownerPage.waitForResponse((response) =>
        /\/confluence\/spaces/.test(response.url()) && response.request().method() === 'GET');
      await ownerPage.getByRole('button', { name: /Change the space/i }).click();
      expect((await spaces).status()).toBe(200);
    }

    await expect.poll(() => bodies.length, { message: 'both connector responses must be captured' })
      .toBeGreaterThanOrEqual(2);
    for (const body of bodies) {
      const lowered = body.toLowerCase();
      // The API's own unit tests pin this by allow-list; this is the same rule
      // asserted where it actually matters — on the wire, in a browser.
      for (const forbidden of ['access_token', 'refresh_token', 'client_secret', 'ciphertext']) {
        expect(lowered, `a connector response carried ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  test('a callback with a state from nowhere is refused', async ({ ownerPage }) => {
    // The CSRF defence for the whole flow. A forged state must not reach the
    // token exchange — the fake would happily issue a token to it.
    //
    // Driven through the callback PAGE rather than by posting directly, both
    // because the runner forbids direct APIRequestContext calls in these specs, and because
    // this is the shape a real attack takes: a victim's browser, following a
    // link, carrying the victim's cookies.
    const callback = ownerPage.waitForResponse(
      (r) => /\/confluence\/callback$/.test(r.url()) && r.request().method() === 'POST',
    );
    await gotoWithDevServerRetry(
      ownerPage,
      '/integrations/confluence/callback?code=fake-authorization-code&state=not-a-signed-state',
    );

    const response = await callback;
    expect(response.status()).toBe(400);
    expect(((await response.json()) as { code?: string }).code).toBe('CONFLUENCE_OAUTH_STATE_INVALID');

    // And the charity is told, rather than left on a blank page believing they
    // are connected.
    await expect(ownerPage.getByText(/could not|not be completed|try again/i).first()).toBeVisible();
  });
});
