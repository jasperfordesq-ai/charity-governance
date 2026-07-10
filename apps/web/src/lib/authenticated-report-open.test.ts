import assert from 'node:assert/strict';
import test from 'node:test';
import {
  openAuthenticatedReport,
  type AuthenticatedReportPopup,
} from './authenticated-report-open';

function popup(overrides: Partial<AuthenticatedReportPopup> = {}) {
  const navigations: string[] = [];
  let closedByApp = false;
  const value: AuthenticatedReportPopup = {
    closed: false,
    opener: { unsafe: true },
    location: { replace: (url) => navigations.push(url) },
    close: () => {
      closedByApp = true;
    },
    ...overrides,
  };
  return { value, navigations, wasClosedByApp: () => closedByApp };
}

test('opens the popup synchronously, severs its opener, then navigates to the authenticated blob', async () => {
  const target = popup();
  const events: string[] = [];
  const revoked: string[] = [];
  let scheduled: (() => void) | null = null;

  const result = await openAuthenticatedReport({
    openPopup: () => {
      events.push('popup');
      return target.value;
    },
    fetchReport: async () => {
      events.push('fetch');
      return new Blob(['report'], { type: 'text/html' });
    },
    createObjectUrl: () => 'blob:charitypilot-report',
    revokeObjectUrl: (url) => revoked.push(url),
    scheduleRevoke: (callback) => {
      scheduled = callback;
    },
  });

  assert.deepEqual(result, { status: 'opened' });
  assert.deepEqual(events, ['popup', 'fetch']);
  assert.equal(target.value.opener, null);
  assert.deepEqual(target.navigations, ['blob:charitypilot-report']);
  assert.deepEqual(revoked, []);
  assert.ok(scheduled);
  (scheduled as () => void)();
  assert.deepEqual(revoked, ['blob:charitypilot-report']);
});

test('does not fetch when the browser blocks the popup', async () => {
  let fetched = false;
  const result = await openAuthenticatedReport({
    openPopup: () => null,
    fetchReport: async () => {
      fetched = true;
      return new Blob();
    },
    createObjectUrl: () => 'blob:unused',
    revokeObjectUrl: () => undefined,
    scheduleRevoke: () => undefined,
  });

  assert.deepEqual(result, { status: 'blocked' });
  assert.equal(fetched, false);
});

test('closes the placeholder popup and revokes an allocated URL when navigation fails', async () => {
  const target = popup({
    location: {
      replace: () => {
        throw new Error('navigation failed');
      },
    },
  });
  const revoked: string[] = [];

  const result = await openAuthenticatedReport({
    openPopup: () => target.value,
    fetchReport: async () => new Blob(['report']),
    createObjectUrl: () => 'blob:failed-report',
    revokeObjectUrl: (url) => revoked.push(url),
    scheduleRevoke: () => undefined,
  });

  assert.equal(result.status, 'error');
  assert.equal(target.wasClosedByApp(), true);
  assert.deepEqual(revoked, ['blob:failed-report']);
});
