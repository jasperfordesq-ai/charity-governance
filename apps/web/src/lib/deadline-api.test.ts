import assert from 'node:assert/strict';
import test from 'node:test';

import { collectAllDeadlinePages, decodeDeadlinePage } from './deadline-api';

test('deadline page decoder accepts paginated and legacy array responses', () => {
  assert.deepEqual(decodeDeadlinePage<number>({ data: [1, 2], total: 3, page: 1, pageSize: 2, hasMore: true }), {
    data: [1, 2],
    total: 3,
    page: 1,
    pageSize: 2,
    hasMore: true,
  });
  assert.deepEqual(decodeDeadlinePage<number>([1]), {
    data: [1],
    total: 1,
    page: 1,
    pageSize: 1,
    hasMore: false,
  });
  assert.deepEqual(decodeDeadlinePage<number>({ data: { data: [7], total: 1 } }).data, [7]);
});

test('current-deadline collection follows every bounded page instead of truncating at 100', async () => {
  const requestedPages: number[] = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => index + 1);
  const rows = await collectAllDeadlinePages(async (page) => {
    requestedPages.push(page);
    return page === 1
      ? { data: firstPage, total: 101, page: 1, pageSize: 100, hasMore: true }
      : { data: [101], total: 101, page: 2, pageSize: 100, hasMore: false };
  });

  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(rows.length, 101);
  assert.equal(rows.at(-1), 101);
});

test('deadline collection fails closed when a paginated response cannot advance', async () => {
  await assert.rejects(
    () => collectAllDeadlinePages(async () => ({
      data: [],
      total: 1,
      page: 1,
      pageSize: 100,
      hasMore: true,
    })),
    /did not advance safely/,
  );
});
