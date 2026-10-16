import { test, expect } from '@playwright/test';
import { buildMinimisedComplianceReportHtml } from '../../apps/api/src/routes/export/compliance-report-html';

test('minimised report retains an allowed long organisation name inside screen and print bounds', async ({ page }) => {
  test.skip(process.env.E2E_DEPLOYED_QA === 'true', 'Local renderer proof cannot attest a deployed report.');
  // This deliberately isolated renderer fixture is not a real Board approval.
  const name = `SYNTHETIC-${'W'.repeat(290)}`;
  const html = buildMinimisedComplianceReportHtml({
    evidence: { organisation: { name, rcnNumber: 'SYNTHETIC-NOT-REAL' }, reportingYear: 2026,
      standards: [{ record: { status: 'COMPLIANT' } }, { record: null }] },
    approval: { sequence: 1, approvedAt: '2026-10-16T05:00:00.000Z' },
  } as Parameters<typeof buildMinimisedComplianceReportHtml>[0]);
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.route('**/*', route => route.abort());
  await page.setContent(html);
  for (const media of ['screen', 'print'] as const) {
    await page.emulateMedia({ media });
    for (const width of [375, 794, 1280]) {
      await page.setViewportSize({ width, height: 1123 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${media} at ${width}px`).toBe(width);
      const fragments = await page.locator('p').filter({ hasText: name }).evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        return Array.from(range.getClientRects(), rect => ({ left: rect.left, right: rect.right }));
      });
      expect(fragments.length).toBeGreaterThan(1);
      expect(fragments.every(rect => rect.left >= 0 && rect.right <= width)).toBe(true);
      await expect(page.getByText(name, { exact: false })).toBeVisible();
      await expect(page.locator('.notice')).toContainText('does not authorise disclosure');
      await expect(page.locator('tbody tr')).toHaveCount(5);
      expect(await page.locator('tbody td').evaluateAll(cells =>
        cells.reduce((total, cell) => total + Number(cell.textContent), 0))).toBe(2);
    }
  }
  expect(requests).toEqual([]);
});
