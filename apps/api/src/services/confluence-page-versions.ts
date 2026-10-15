import { AppError } from '../utils/app-error.js';
import type { ConfluenceClient } from './confluence-client.js';
import { readConfluenceInventoryCursor } from './confluence-inventory-pagination.js';

function invalid(): AppError {
  return new AppError(502, 'CONFLUENCE_PAGE_VERSION_INVENTORY_INVALID',
    'Confluence did not return a complete bounded version inventory for the exact page.');
}

/** Read provider-listed page versions, not page bodies or erasure authority.
 * https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-version/
 */
export async function listConfluencePageVersions(
  client: ConfluenceClient, pageId: string, maxVersions = 1000, signal?: AbortSignal,
): Promise<number[]> {
  if (typeof pageId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(pageId)
    || !Number.isSafeInteger(maxVersions) || maxVersions < 1 || maxVersions > 1000) {
    throw new AppError(400, 'CONFLUENCE_PAGE_VERSION_INPUT_INVALID', 'An exact page and bounded version limit are required.');
  }
  const numbers = new Set<number>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 40; page++) {
    signal?.throwIfAborted();
    const response = await client.request({ method: 'GET', api: 'v2', path: `pages/${pageId}/versions`,
      query: { limit: String(Math.min(250, maxVersions - numbers.size)), ...(cursor === undefined ? {} : { cursor }) },
      idempotent: true });
    signal?.throwIfAborted();
    if (response.status !== 200 || response.body === null || typeof response.body !== 'object') throw invalid();
    const results = (response.body as Record<string, unknown>).results;
    if (!Array.isArray(results)) throw invalid();
    for (const result of results) {
      if (result === null || typeof result !== 'object') throw invalid();
      const row = result as Record<string, unknown>;
      const parent = row.page;
      if (parent === null || typeof parent !== 'object' || (parent as Record<string, unknown>).id !== pageId
        || typeof row.number !== 'number' || !Number.isSafeInteger(row.number) || row.number < 1
        || numbers.has(row.number) || numbers.size >= maxVersions) throw invalid();
      numbers.add(row.number);
    }
    cursor = readConfluenceInventoryCursor(response.body, response.linkHeader, invalid);
    if (cursor === undefined) {
      if (numbers.size === 0) throw invalid();
      return [...numbers].sort((a, b) => a - b);
    }
    if (numbers.size >= maxVersions || cursors.has(cursor)) throw invalid();
    cursors.add(cursor);
  }
  throw invalid();
}
