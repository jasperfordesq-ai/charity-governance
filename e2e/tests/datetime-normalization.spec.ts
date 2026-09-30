import { test, expect } from '../fixtures';
import { localDateTimeValue } from '../helpers/local-date-time';

test('copy evidence times fill native controls without losing milliseconds', async ({ page }) => {
  await page.setContent('<input aria-label="Observation" type="datetime-local" step="0.001">');
  for (const now of ['2026-09-30T17:45:05.710Z', '2026-09-30T17:46:54.600Z',
    '2026-09-30T17:46:54.000Z', '2026-09-30T17:46:00.000Z', '2026-09-30T17:46:54.001Z']) {
    for (const offset of [0, 86400000]) {
      const value = await page.evaluate(localDateTimeValue, { now, offset });
      await page.getByLabel('Observation').fill(value);
      const timestamp = await page.getByLabel('Observation').evaluate((input: HTMLInputElement) => new Date(input.value).getTime());
      expect(timestamp).toBe(new Date(now).getTime() + offset);
    }
  }
});
