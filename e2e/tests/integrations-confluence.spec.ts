import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { IS_DEPLOYED_QA } from '../env';
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
  test.skip(IS_DEPLOYED_QA, 'Fake provider and controlled response loss require the disposable environment.');
  test('an external Confluence document registers, checks, reports and uncites without a Vault upload', async ({ newFencedContext }) => {
    test.setTimeout(120_000);
    const owner = await createVerifiedOwner({ email: uniqueEmail('confluence-source'), password: TEST_PASSWORD,
      name: 'Reference-only Owner', organisationName: 'Synthetic Reference-only Charity' });
    const context = await newFencedContext({ storageState: await createAuthenticatedStorageState({ ...owner, role: 'OWNER' }) });
    const page = await context.newPage();
    await gotoWithDevServerRetry(page, '/integrations');
    const authorised = page.waitForResponse(response => /\/confluence\/authorize$/.test(response.url()) && response.request().method() === 'GET');
    await page.getByRole('button', { name: 'Connect Confluence', exact: true }).click();
    const authorization = await authorised;
    expect(authorization.status()).toBe(200);
    const continueButton = page.getByRole('button', { name: /continue to Atlassian/i });
    await expect(continueButton).toBeVisible();
    const authorizationUrl = await continueButton.getAttribute('href');
    const state = new URL(authorizationUrl!).searchParams.get('state');
    expect(state).toBeTruthy();
    const callback = page.waitForResponse(response => /\/confluence\/callback$/.test(response.url()) && response.request().method() === 'POST');
    await gotoWithDevServerRetry(page, `/integrations/confluence/callback?code=fake-authorization-code&state=${encodeURIComponent(state!)}`);
    expect((await callback).status()).toBe(200);
    await gotoWithDevServerRetry(page, '/integrations');
    const registration = page.getByRole('region', { name: 'Register a Confluence document', exact: true });
    await expect(registration.getByLabel('Confluence source page ID', { exact: true })).toBeEnabled();
    await reliableFill(registration.getByLabel('Confluence source page ID', { exact: true }), 'synthetic-retained-copy');
    await registration.getByRole('checkbox', { name: /I reviewed the connected site/ }).check();
    await reliableFill(registration.getByLabel('Confluence source page ID', { exact: true }), 'synthetic-observation-control');
    await expect(registration.getByRole('checkbox', { name: /I reviewed the connected site/ })).not.toBeChecked();
    await expect(registration.getByRole('button', { name: 'Verify and register external document', exact: true })).toBeDisabled();
    await reliableFill(registration.getByLabel('Confluence source page ID', { exact: true }), 'synthetic-retained-copy');
    await registration.getByRole('checkbox', { name: /I reviewed the connected site/ }).check();
    const sourcePath = /\/api\/v1\/integrations\/confluence\/sources$/;
    let originalSourceId: string | null = null, sourceWrites = 0;
    page.on('request', request => { if (sourcePath.test(request.url()) && request.method() === 'POST') sourceWrites++; });
    await page.route(sourcePath, async route => {
      const committed = await route.fetch({ maxRedirects: 0 });
      expect(committed.status(), await committed.text()).toBe(200);
      originalSourceId = (await committed.json()).data.reference.id;
      await route.abort('failed');
    });
    await registration.getByRole('button', { name: 'Verify and register external document', exact: true }).click();
    await expect(registration.getByRole('alert')).toContainText('Retry uses the same request');
    expect(sourceWrites).toBe(1);
    await page.unroute(sourcePath);
    const registered = page.waitForResponse(response => /\/confluence\/sources$/.test(response.url()) && response.request().method() === 'POST');
    await registration.getByRole('button', { name: 'Retry original source registration', exact: true }).click();
    const response = await registered;
    expect(response.status(), await response.text()).toBe(200);
    const source = (await response.json()).data.reference;
    expect(source.id).toBe(originalSourceId); expect(sourceWrites).toBe(2);
    expect(source.documentId).toBeNull(); expect(source.pageVersion).toBe(1);
    const row = page.getByRole('listitem').filter({ hasText: `Citation ${source.id}` });
    await expect(row.getByText(/External document — no Vault upload/)).toBeVisible();
    await expect(row.getByText(/attached to a document that is not currently classified/)).toHaveCount(0);
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { localStorage.setItem('charitypilot-theme', value); document.documentElement.classList.toggle('dark', value === 'dark'); }, theme);
      await row.screenshot({ path: test.info().outputPath(`reference-only-${theme}.png`), animations: 'disabled' });
    }
    expect((await new AxeBuilder({ page }).include('section[aria-label="Register a Confluence document"]').analyze()).violations).toEqual([]);
    await row.getByRole('button', { name: 'Check external source version', exact: true }).click();
    await expect(row.getByRole('status')).toHaveText('Current at check: version 1.');
    const observation = row.getByRole('region', { name: 'Cited page lifecycle observation' });
    await reliableFill(observation.getByLabel('Separate accessible control page ID', { exact: true }), 'synthetic-observation-control');
    await observation.getByRole('button', { name: 'Observe cited page', exact: true }).click();
    await expect(observation.getByText('Page visible at check.', { exact: true })).toBeVisible();
    await observation.getByRole('button', { name: 'Prepare citation review report', exact: true }).click();
    const report = observation.getByRole('region', { name: 'Confluence citation review report' });
    await reliableFill(report.getByLabel('Review evidence reference', { exact: true }), 'SYNTHETIC-SOURCE-REVIEW');
    await reliableFill(report.getByLabel('Review report reason', { exact: true }), 'Synthetic external source with no uploaded local document and no disposal instruction.');
    await report.getByRole('checkbox', { name: /I reviewed these references/ }).check();
    await report.getByRole('button', { name: 'Save review report', exact: true }).click();
    await expect(report.getByText(/Historical report recorded:/)).toBeVisible();
    const saved = await withDb(async client => (await client.query(`SELECT id,context FROM "SecurityAuditEvent"
      WHERE "organisationId"=$1 AND type='CONFLUENCE_CITATION_REVIEW_RECORDED'`, [owner.organisationId])).rows[0]);
    expect(saved.context.citation.documentId).toBeNull(); expect(saved.context.instruction).toBeNull();
    await row.getByRole('button', { name: 'Remove local source reference', exact: true }).click();
    await row.getByRole('button', { name: 'Confirm local reference removal', exact: true }).click();
    await expect(row).toHaveCount(0);
    const counts = await withDb(async client => {
      const result: Record<string, number> = {};
      for (const table of ['Document', 'DocumentUploadIntent', 'DocumentPublication', 'DocumentStorageDeletion', 'ConfluenceReference']) {
        result[table] = Number((await client.query(`SELECT count(*) FROM "${table}" WHERE "organisationId"=$1`, [owner.organisationId])).rows[0].count);
      }
      const audit = await client.query(`SELECT type FROM "SecurityAuditEvent" WHERE "organisationId"=$1 AND type IN
        ('CONFLUENCE_SOURCE_REGISTERED','CONFLUENCE_SOURCE_REMOVED') ORDER BY "occurredAt"`, [owner.organisationId]);
      expect(audit.rows.map(item => item.type)).toEqual(['CONFLUENCE_SOURCE_REGISTERED', 'CONFLUENCE_SOURCE_REMOVED']);
      return result;
    });
    expect(Object.values(counts)).toEqual([0, 0, 0, 0, 0]);
    const lookup = page.getByRole('region', { name: 'Historical Confluence citation review lookup' });
    await reliableFill(lookup.getByLabel('Original request or audit event reference', { exact: true }), saved.id);
    await lookup.getByRole('button', { name: 'Read historical citation review report', exact: true }).click();
    await expect(lookup.getByText(`Historical report recorded: ${saved.id}`, { exact: true })).toBeVisible();
    await context.close();
  });
  test('disclosure, connect, choose a space, and review the exact destination before approval', async ({ newFencedContext, browserOriginFence }) => {
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
    // Cite an existing page through the real UI/API/database. The fake provider
    // supplies the page; this is distinct from approving a published copy.
    await row.getByRole('button', { name: `Review Confluence citations for ${documentName}` }).click();
    const citations = ownerPage.getByRole('dialog', { name: `Confluence citations — ${documentName}`, exact: true });
    await expect(citations.getByText(/Connected site:.*charity-e2e.atlassian.net/)).toBeVisible();
    await reliableFill(citations.getByLabel('Confluence page ID'), 'synthetic-retained-copy');
    const cited = ownerPage.waitForResponse(response =>
      response.url().endsWith(`/confluence/references/${documentId}`) && response.request().method() === 'POST');
    await citations.getByRole('button', { name: 'Verify and cite page', exact: true }).click();
    const citeResponse = await cited;
    expect(citeResponse.status(), await citeResponse.text()).toBe(200);
    const reference = (await citeResponse.json()).data.reference;
    expect(reference.pageId).toBe('synthetic-retained-copy');
    expect(reference.pageVersion).toBe(1);
    await expect(citations.getByRole('status')).toContainText('version 1');
    await expect(citations.getByText('Page synthetic-retained-copy · cited version 1')).toBeVisible();
    await citations.getByRole('button', { name: 'Check upstream version for Synthetic retained copy', exact: true }).click();
    await expect(citations.getByText('Current at check: version 1.', { exact: false })).toBeVisible();
    const citationBefore = await withDb(async client => (await client.query('SELECT row_to_json(r) AS row FROM "ConfluenceReference" r WHERE id=$1', [reference.id])).rows[0].row);
    const observationPanel = citations.getByRole('region', { name: 'Cited page lifecycle observation' });
    const controlPage = observationPanel.getByLabel('Separate accessible control page ID', { exact: true });
    await reliableFill(controlPage, 'synthetic-observation-control');
    const observationResponse = ownerPage.waitForResponse(response => response.url().includes(`/references/by-id/${reference.id}/observation?`) && response.request().method() === 'GET');
    await observationPanel.getByRole('button', { name: 'Observe cited page', exact: true }).click();
    const observed = await observationResponse;
    expect(observed.status(), await observed.text()).toBe(200);
    expect((await observed.json()).data.observation).toMatchObject({ referenceId: reference.id,
      status: 'VISIBLE', scope: 'CITED_PAGE_ONLY', attachmentsObserved: false, jobCreated: false,
      citationUpdated: false, permanentErasureVerified: false, actionAuthorized: false });
    await expect(observationPanel.getByText('Page visible at check.', { exact: true })).toBeVisible();
    await observationPanel.getByRole('button', { name: 'Prepare citation review report', exact: true }).click();
    const citationReport = observationPanel.getByRole('region', { name: 'Confluence citation review report' });
    for (const width of [320, 768, 1440]) {
      await ownerPage.setViewportSize({ width, height: 1000 });
      expect(await observationPanel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    await ownerPage.emulateMedia({ reducedMotion: 'reduce' });
    for (const theme of ['light', 'dark']) {
      await ownerPage.evaluate(value => {
        localStorage.setItem('theme', value); document.documentElement.classList.toggle('dark', value === 'dark');
        window.dispatchEvent(new Event('themechange'));
      }, theme);
      await observationPanel.evaluate(async node => {
        getComputedStyle(node).color;
        await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
      });
      const scan = await new AxeBuilder({ page: ownerPage }).include('[aria-label="Cited page lifecycle observation"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(scan.violations).toEqual([]);
      await observationPanel.screenshot({ path: test.info().outputPath(`citation-observation-${theme}.png`) });
    }
    await reliableFill(citationReport.getByLabel('Review evidence reference', { exact: true }), 'SYNTHETIC-CITATION-REVIEW');
    await reliableFill(citationReport.getByLabel('Review report reason', { exact: true }), 'Synthetic cited-page observation; no deletion instruction or administrator disposal is asserted.');
    await citationReport.getByRole('checkbox', { name: /I reviewed these references/ }).check();
    const citationReportUrl = `${browserOriginFence.apiOrigin}/api/v1/integrations/confluence/references/by-id/${reference.id}/reviews`;
    let citationReportSaves = 0;
    await ownerPage.route(citationReportUrl, async route => {
      expect(route.request().method()).toBe('POST'); citationReportSaves++;
      const committed = await route.fetch({ maxRedirects: 0 });
      expect(committed.status(), await committed.text()).toBe(200);
      expect((await committed.json()).data.review.instruction).toBeNull();
      await route.abort('failed');
    });
    await citationReport.getByRole('button', { name: 'Save review report', exact: true }).click();
    await expect(citationReport.getByText('Report outcome needs reconciliation.', { exact: true })).toBeVisible();
    await expect(citationReport.getByRole('button', { name: 'Save review report', exact: true })).toBeDisabled();
    await citationReport.getByRole('button', { name: 'Look up original report receipt', exact: true }).click();
    await expect(citationReport.getByText(/Historical report recorded:/)).toBeVisible();
    expect(citationReportSaves).toBe(1);
    const citationReviewAudit = await withDb(async client => {
      const rows = await client.query(`SELECT id,context FROM "SecurityAuditEvent" WHERE "organisationId"=$1 AND type='CONFLUENCE_CITATION_REVIEW_RECORDED'`, [owner.organisationId]);
      expect(rows.rows).toHaveLength(1); const audit = rows.rows[0];
      expect(audit.context.instruction).toBeNull(); expect(audit.context.citation.id).toBe(reference.id);
      expect(audit.context.observation.scope).toBe('CITED_PAGE_ONLY'); expect(audit.context.observation.jobCreated).toBe(false);
      expect(audit.context.actionAuthorized).toBe(false); return audit;
    });
    await expect(withDb(async client => { await client.query(`UPDATE "SecurityAuditEvent" SET reason='Changed report' WHERE id=$1`, [citationReviewAudit.id]); })).rejects.toThrow(/55000/);
    await expect(withDb(async client => { await client.query(`INSERT INTO "SecurityAuditEvent" (id,"organisationId",type,"actorKind","actorUserId","actorLabel","subjectLabel",reason,context)
      SELECT $2,"organisationId",type,"actorKind","actorUserId","actorLabel","subjectLabel",reason,context FROM "SecurityAuditEvent" WHERE id=$1`, [citationReviewAudit.id, `${citationReviewAudit.id}-duplicate`]); })).rejects.toThrow(/23505/);
    await expect(withDb(async client => { await client.query(`INSERT INTO "SecurityAuditEvent" (id,"organisationId",type,"actorKind","actorUserId","actorLabel","subjectLabel",reason)
      SELECT $2,"organisationId",'MEMBER_ROLE_CHANGED',"actorKind","actorUserId","actorLabel","subjectLabel",reason FROM "SecurityAuditEvent" WHERE id=$1`, [citationReviewAudit.id, `${citationReviewAudit.id}-no-subject`]); })).rejects.toThrow(/23514/);
    await reliableFill(controlPage, 'missing-control');
    await expect(observationPanel.getByText('Page visible at check.', { exact: true })).toHaveCount(0);
    await observationPanel.getByRole('button', { name: 'Observe cited page', exact: true }).click();
    await expect(observationPanel.getByText(/Unknown: review the connection/)).toBeVisible();
    await citations.getByRole('button', { name: 'Refresh citations', exact: true }).click();
    await expect(observationPanel.getByText(/Unknown: review the connection/)).toHaveCount(0);
    await expect(controlPage).toHaveValue('');
    await withDb(async client => {
      expect((await client.query('SELECT row_to_json(r) AS row FROM "ConfluenceReference" r WHERE id=$1', [reference.id])).rows[0].row).toEqual(citationBefore);
      expect((await client.query('SELECT id FROM "DocumentStorageDeletion" WHERE "organisationId"=$1', [owner.organisationId])).rowCount).toBe(0);
    });
    await withDb(async client => {
      const saved = await client.query('SELECT "pageVersion" FROM "ConfluenceReference" WHERE id=$1', [reference.id]);
      expect(saved.rows).toEqual([{ pageVersion: 1 }]);
      expect((await client.query('SELECT id FROM "DocumentControlAudit" WHERE "documentId"=$1 AND kind=\'CONFLUENCE_REFERENCE\'', [documentId])).rowCount).toBe(1);
    });
    await citations.getByRole('button', { name: 'Remove citation for Synthetic retained copy', exact: true }).click();
    await expect(citations.getByText(/The Confluence page and its attachments stay unchanged/)).toBeVisible();
    const uncited = ownerPage.waitForResponse(response =>
      response.url().endsWith(`/confluence/references/by-id/${reference.id}`) && response.request().method() === 'DELETE');
    await citations.getByRole('button', { name: 'Confirm citation removal', exact: true }).click();
    expect((await uncited).status()).toBe(204);
    await expect(citations.getByText('No citations are recorded for this document.')).toBeVisible();
    await withDb(async client => {
      const refs = await client.query('SELECT id FROM "ConfluenceReference" WHERE "documentId"=$1', [documentId]);
      expect(refs.rowCount).toBe(0);
      const audits = await client.query('SELECT previous,next FROM "DocumentControlAudit" WHERE "documentId"=$1 AND kind=\'CONFLUENCE_REFERENCE\' ORDER BY "occurredAt",id', [documentId]);
      expect(audits.rows).toEqual([
        { previous: 'UNLINKED', next: `CITED:${reference.id}` },
        { previous: `CITED:${reference.id}`, next: 'UNLINKED' },
      ]);
      const jobs = await client.query('SELECT id FROM "DocumentStorageDeletion" WHERE "organisationId"=$1', [owner.organisationId]);
      expect(jobs.rowCount).toBe(0);
    });
    // A stored citation with a lost response must not trigger an automatic
    // second POST or a success message. Reconcile through the real GET list.
    for (const width of [320, 768, 1024, 1440]) {
      await ownerPage.setViewportSize({ width, height: 800 });
      const bounds = await citations.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.width).toBeLessThanOrEqual(width);
    }
    let createAttempts = 0;
    const citationPath = `${browserOriginFence.apiOrigin}/api/v1/integrations/confluence/references/${documentId}`;
    await ownerPage.route(citationPath, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      createAttempts++;
      const committed = await route.fetch({ maxRedirects: 0 });
      expect(committed.status(), await committed.text()).toBe(200);
      await route.abort('failed');
    });
    await reliableFill(citations.getByLabel('Confluence page ID'), 'synthetic-retained-copy');
    await citations.getByRole('button', { name: 'Verify and cite page', exact: true }).click();
    await expect(citations.getByRole('alert')).toContainText('could not be confirmed');
    await expect(citations.getByRole('button', { name: 'Verify and cite page', exact: true })).toBeDisabled();
    expect(createAttempts).toBe(1);
    await citations.getByRole('button', { name: 'Refresh citations', exact: true }).click();
    await expect(citations.getByText('Page synthetic-retained-copy · cited version 1')).toBeVisible();
    await citations.getByRole('button', { name: 'Remove citation for Synthetic retained copy', exact: true }).click();
    await citations.getByRole('button', { name: 'Confirm citation removal', exact: true }).click();
    await expect(citations.getByText('No citations are recorded for this document.')).toBeVisible();
    expect(createAttempts).toBe(1);
    await ownerPage.unroute(citationPath);
    await withDb(async client => {
      expect((await client.query('SELECT id FROM "ConfluenceReference" WHERE "documentId"=$1', [documentId])).rowCount).toBe(0);
      expect((await client.query('SELECT id FROM "DocumentControlAudit" WHERE "documentId"=$1 AND kind=\'CONFLUENCE_REFERENCE\'', [documentId])).rowCount).toBe(4);
      expect((await client.query('SELECT id FROM "DocumentStorageDeletion" WHERE "organisationId"=$1', [owner.organisationId])).rowCount).toBe(0);
    });
    await ownerPage.setViewportSize({ width: 1280, height: 720 });
    await citations.getByRole('button', { name: 'Close citations', exact: true }).click();
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
    await gotoWithDevServerRetry(ownerPage, '/integrations');
    const citationHistory = ownerPage.getByRole('region', { name: 'Historical Confluence citation review lookup' });
    await reliableFill(citationHistory.getByLabel('Original request or audit event reference', { exact: true }), citationReviewAudit.id);
    await citationHistory.getByRole('button', { name: 'Read historical citation review report', exact: true }).click();
    await expect(citationHistory.getByText(`Historical report recorded: ${citationReviewAudit.id}`, { exact: true })).toBeVisible();
    await expect(citationHistory.getByText(/No deletion instruction recorded/)).toBeVisible();
    expect(citationReportSaves).toBe(1);
  });

  test('no token material reaches the browser in observed connector responses', async ({ newFencedContext }) => {
    test.setTimeout(120_000);
    const owner = await createVerifiedOwner({ email: uniqueEmail('confluence-disclosure'), password: TEST_PASSWORD,
      name: 'Disclosure Owner', organisationName: 'Isolated Disclosure Charity' });
    const storageState = await createAuthenticatedStorageState({ ...owner, role: 'OWNER' });
    const context = await newFencedContext({ storageState });
    const ownerPage = await context.newPage();
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
    // Exercise both disconnected and connected responses deterministically.
    // A connected account can lack a selected space; it need not offer Change.
    await expect(ownerPage.getByRole('button', { name: 'Connect Confluence' })).toBeVisible();
    const authorize = ownerPage.waitForResponse((response) =>
      /\/confluence\/authorize$/.test(response.url()) && response.request().method() === 'GET');
    await ownerPage.getByRole('button', { name: 'Connect Confluence' }).click();
    expect((await authorize).status()).toBe(200);
    const continueButton = ownerPage.getByRole('button', { name: /continue to Atlassian/i });
    await expect(continueButton).toBeVisible();
    const authorizationUrl = await continueButton.getAttribute('href');
    expect(authorizationUrl).toBeTruthy();
    const state = new URL(authorizationUrl!).searchParams.get('state');
    expect(state).toBeTruthy();
    const callback = ownerPage.waitForResponse((response) =>
      /\/confluence\/callback$/.test(response.url()) && response.request().method() === 'POST');
    await gotoWithDevServerRetry(ownerPage,
      `/integrations/confluence/callback?code=fake-authorization-code&state=${encodeURIComponent(state!)}`);
    expect((await callback).status()).toBe(200);
    await gotoWithDevServerRetry(ownerPage, '/integrations');
    await expect(ownerPage.getByRole('button', { name: /Choose a space/i })).toBeVisible();
    const spaces = ownerPage.waitForResponse((response) =>
      /\/confluence\/spaces/.test(response.url()) && response.request().method() === 'GET');
    await ownerPage.getByRole('button', { name: /Choose a space/i }).click();
    expect((await spaces).status()).toBe(200);

    await expect.poll(() => bodies.length, { message: 'status, authorize, callback and spaces responses must be captured' })
      .toBeGreaterThanOrEqual(5);
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
