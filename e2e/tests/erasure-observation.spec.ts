import AxeBuilder from '@axe-core/playwright';
import path from 'node:path';
import { test, expect, reliableFill, uniqueEmail, TEST_PASSWORD } from '../fixtures';
import { createAuthenticatedStorageState, createVerifiedOwner, withDb } from '../helpers/db';
import { gotoWithDevServerRetry } from '../helpers/navigation';
import { IS_DEPLOYED_QA } from '../env';

test('Owner observes a recorded deletion target without claiming erasure or changing the job', async ({ newFencedContext, browserOriginFence }) => {
  test.skip(IS_DEPLOYED_QA, 'Preexisting synthetic deletion fixture requires the runner-owned disposable database.');
  test.setTimeout(180_000);
  const owner = await createVerifiedOwner({ email: uniqueEmail('erasure-observation'), password: TEST_PASSWORD,
    name: 'Synthetic Observation Owner', organisationName: 'Isolated Observation Charity' });
  const context = await newFencedContext({ storageState: await createAuthenticatedStorageState({ ...owner, role: 'OWNER' }) });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  try {
    await gotoWithDevServerRetry(page, '/integrations');
    await page.getByRole('button', { name: 'Connect Confluence', exact: true }).click();
    const consent = page.getByRole('button', { name: /continue to Atlassian/i });
    const state = new URL((await consent.getAttribute('href'))!).searchParams.get('state');
    expect(state).toBeTruthy();
    const callback = page.waitForResponse(r => r.url().endsWith('/confluence/callback') && r.request().method() === 'POST');
    await gotoWithDevServerRetry(page, `/integrations/confluence/callback?code=fake-authorization-code&state=${encodeURIComponent(state!)}`);
    expect((await callback).status()).toBe(200);
    await gotoWithDevServerRetry(page, '/documents');
    await page.getByRole('button', { name: /Upload document/i }).click();
    await reliableFill(page.getByLabel('Document name'), 'Synthetic observation source retained locally');
    await page.locator('#document-upload-file').setInputFiles(path.resolve(__dirname, '../fixtures/sample-document.txt'));
    const uploaded = page.waitForResponse(r => r.url().endsWith('/api/v1/documents') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    const upload = await uploaded;
    expect(upload.status(), await upload.text()).toBe(201);
    const documentId = (await upload.json()).data.id as string;
    const stamp = Date.now(), jobId = `observation-job-${stamp}`, publicationId = `observation-pub-${stamp}`;
    // A preexisting job fixture, not a fabricated approval or a runtime grant.
    // The runner's independent identity check fences all setup to its own DB.
    const before = await withDb(async client => {
      await client.query(`INSERT INTO "DocumentPublication" (id,"organisationId","documentId",provider,"cloudId","spaceId","pageId","pageTitle",state,"retiredAt","nextAttemptAt","updatedAt")
        VALUES ($1,$2,$3,'confluence','00000000-0000-4000-8000-000000000001','space-gov',$4,'Synthetic recorded erasure target','RETIRED',NOW(),NULL,NOW())`,
      [publicationId, owner.organisationId, documentId, `absent-${stamp}`]);
      await client.query(`UPDATE "DocumentPublication" SET "erasureRequestedAt"=NOW(),"erasureDeletionId"=$3 WHERE id=$1 AND "organisationId"=$2`,
        [publicationId, owner.organisationId, jobId]);
      await client.query(`INSERT INTO "DocumentStorageDeletion" (id,"organisationId","storagePath","sourceDocumentId",provider,"targetRef",reason,"requestedById","nextAttemptAt")
        VALUES ($1,$2,'publication:'||$6,$3,'confluence',$4::jsonb,'Synthetic preexisting request fixture; no disposal execution',$5,NOW()+INTERVAL '1 day')`,
      [jobId, owner.organisationId, documentId, JSON.stringify({ kind: 'confluence', cloudId: '00000000-0000-4000-8000-000000000001', pageId: `absent-${stamp}`, attachmentIds: [] }), owner.userId, publicationId]);
      return (await client.query(`SELECT row_to_json(d) AS original FROM "DocumentStorageDeletion" d WHERE id=$1 AND "organisationId"=$2`, [jobId, owner.organisationId])).rows[0].original;
    });
    await gotoWithDevServerRetry(page, '/integrations');
    await page.getByRole('button', { name: 'Observe recorded Confluence target', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Recorded Confluence target observation' });
    const input = panel.getByLabel('Accessible control page ID', { exact: true });
    const read = panel.getByRole('button', { name: 'Read recorded target', exact: true });
    await expect(read).toBeDisabled();
    await reliableFill(input, 'synthetic-retained-copy');
    const observed = page.waitForResponse(r => r.url().includes(`/erasures/${jobId}/observation`) && r.request().method() === 'GET');
    await read.click();
    const response = await observed;
    expect(response.status(), await response.text()).toBe(200);
    const originalObservation = (await response.json()).data.observation;
    expect(originalObservation).toMatchObject({ status: 'NOT_OBSERVED', controlPageReadable: true,
      permanentErasureVerified: false, allCopiesVerified: false, jobUpdated: false, providerMutationIssued: false });
    await expect(panel.getByText('Not observed — absence or restricted access', { exact: true })).toBeVisible();
    await expect(panel.getByText(/The job is unchanged/)).toBeVisible();
    await panel.getByRole('button', { name: 'Prepare review report', exact: true }).click();
    const reportPanel = panel.getByRole('region', { name: 'Confluence erasure review report' });
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => {
        localStorage.setItem('theme', value); document.documentElement.classList.toggle('dark', value === 'dark');
        window.dispatchEvent(new Event('themechange'));
      }, theme);
      if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/(?:^|\s)dark(?:\s|$)/);
      else await expect(page.locator('html')).not.toHaveClass(/(?:^|\s)dark(?:\s|$)/);
      await panel.evaluate(async node => {
        // Read computed style before waiting so newly created theme transitions
        // are included. Assess the rendered state rather than a colour mid-fade.
        getComputedStyle(node).color;
        await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
      });
      const scan = await new AxeBuilder({ page }).include('[aria-label="Recorded Confluence target observation"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(scan.violations).toEqual([]);
      await panel.screenshot({ path: test.info().outputPath(`recorded-target-${theme}.png`) });
    }
    await reliableFill(reportPanel.getByLabel('Review evidence reference', { exact: true }), `SYNTHETIC-REVIEW-${stamp}`);
    await reliableFill(reportPanel.getByLabel('Review report reason', { exact: true }), 'Synthetic review of observed IDs; no administrator disposal action is asserted.');
    await reportPanel.getByRole('checkbox', { name: /I reviewed these references/ }).check();
    const reviewUrl = `${browserOriginFence.apiOrigin}/api/v1/integrations/confluence/erasures/${jobId}/reviews`;
    let saves = 0;
    await page.route(reviewUrl, async route => {
      expect(route.request().method()).toBe('POST'); saves++;
      const committed = await route.fetch({ maxRedirects: 0 });
      expect(committed.status(), await committed.text()).toBe(200);
      expect((await committed.json()).data.review.actionAuthorized).toBe(false);
      await route.abort('failed'); // Lose only the reply after the real commit.
    });
    await reportPanel.getByRole('button', { name: 'Save review report', exact: true }).click();
    await expect(reportPanel.getByText('Report outcome needs reconciliation.', { exact: true })).toBeVisible();
    await expect(reportPanel.getByRole('button', { name: 'Save review report', exact: true })).toBeDisabled();
    await reportPanel.getByRole('button', { name: 'Look up original report receipt', exact: true }).click();
    await expect(reportPanel.getByText(/Historical report recorded:/)).toBeVisible();
    expect(saves).toBe(1);
    const audit = await withDb(async client => {
      const rows = await client.query(`SELECT id,context FROM "SecurityAuditEvent" WHERE "organisationId"=$1 AND type='CONFLUENCE_ERASURE_REVIEW_RECORDED'`, [owner.organisationId]);
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0];
      expect(row.context.observation.targetDigest).toBe(originalObservation.targetDigest);
      expect(row.context.input.actionReport).toBe('NOT_REPORTED');
      expect(row.context.observation.permanentErasureVerified).toBe(false);
      expect(row.context.actionAuthorized).toBe(false);
      return row;
    });
    // Existing append-only trigger plus the new original-request unique index.
    await expect(withDb(async client => { await client.query(`UPDATE "SecurityAuditEvent" SET reason='Changed synthetic report' WHERE id=$1`, [audit.id]); })).rejects.toThrow(/55000/);
    await expect(withDb(async client => { await client.query(`INSERT INTO "SecurityAuditEvent" (id,"organisationId",type,"actorKind","actorUserId","actorLabel","subjectLabel",reason,context)
      SELECT $2,"organisationId",type,"actorKind","actorUserId","actorLabel","subjectLabel",reason,context FROM "SecurityAuditEvent" WHERE id=$1`, [audit.id, `review-duplicate-${stamp}`]); })).rejects.toThrow(/23505/);
    await expect(withDb(async client => { await client.query(`INSERT INTO "SecurityAuditEvent" (id,"organisationId",type,"actorKind","actorUserId","actorLabel","subjectLabel",reason)
      SELECT $2,"organisationId",'MEMBER_ROLE_CHANGED',"actorKind","actorUserId","actorLabel","subjectLabel",reason FROM "SecurityAuditEvent" WHERE id=$1`, [audit.id, `review-invalid-subject-${stamp}`]); })).rejects.toThrow(/23514/);
    await page.reload();
    const historical = page.getByRole('region', { name: 'Historical Confluence review lookup' });
    await reliableFill(historical.getByLabel('Original request or audit event reference', { exact: true }), audit.id);
    await historical.getByRole('button', { name: 'Read historical review report', exact: true }).click();
    await expect(historical.getByText(`Historical report recorded: ${audit.id}`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Observe recorded Confluence target', exact: true }).click();
    await reliableFill(input, 'missing-control');
    await expect(panel.getByText('Not observed — absence or restricted access', { exact: true })).toHaveCount(0);
    await read.click();
    await expect(panel.getByText('Outcome unknown', { exact: true })).toBeVisible();
    await expect(panel.getByText(/The control page could not be read/)).toBeVisible();
    const after = await withDb(async client => (await client.query(`SELECT row_to_json(d) AS original FROM "DocumentStorageDeletion" d WHERE id=$1 AND "organisationId"=$2`, [jobId, owner.organisationId])).rows[0].original);
    expect(after).toEqual(before);
  } finally { await context.close(); }
});
