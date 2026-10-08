import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinateSessionLogout, coordinateSessionRefresh, SessionRefreshLockUnavailableError } from './session-refresh-lock';

function crossTabFixture() {
  let tail: Promise<unknown> = Promise.resolve();
  const locks = {
    request: <T>(_name: string, callback: () => Promise<T>): Promise<T> => {
      const result = tail.then(callback);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  return { locks, storage };
}

test('simultaneous tabs share one successful cookie rotation without storing credentials', async () => {
  const { locks, storage } = crossTabFixture();
  let calls = 0;
  const refresh = async () => { calls += 1; };
  await Promise.all([
    coordinateSessionRefresh(refresh, locks, storage, () => 'rotation-1'),
    coordinateSessionRefresh(refresh, locks, storage, () => 'rotation-2'),
  ]);
  assert.equal(calls, 1);
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'rotation-1');
});

test('sign-out waits for an in-flight refresh before revoking the replacement cookie', async () => {
  const { locks, storage } = crossTabFixture();
  const order: string[] = [];
  let finishRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => { finishRefresh = resolve; });
  const refreshing = coordinateSessionRefresh(async () => {
    order.push('refresh-start');
    await refreshGate;
    order.push('refresh-end');
  }, locks, storage, () => 'rotation');
  await Promise.resolve();
  const signingOut = coordinateSessionLogout(async () => { order.push('logout'); }, locks, storage,
    () => 'logout');
  assert.deepEqual(order, ['refresh-start']);
  finishRefresh();
  await Promise.all([refreshing, signingOut]);
  assert.deepEqual(order, ['refresh-start', 'refresh-end', 'logout']);
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'logout');
});

test('a refresh queued behind successful sign-out never presents the spent cookie', async () => {
  const { locks, storage } = crossTabFixture();
  let finishLogout!: () => void;
  const logoutGate = new Promise<void>((resolve) => { finishLogout = resolve; });
  let refreshes = 0;
  const signingOut = coordinateSessionLogout(async () => { await logoutGate; }, locks, storage,
    () => 'logout');
  await Promise.resolve();
  const refreshing = coordinateSessionRefresh(async () => { refreshes += 1; }, locks, storage,
    () => 'rotation');
  finishLogout();
  await Promise.all([signingOut, refreshing]);
  assert.equal(refreshes, 0);
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'logout');
});

test('failed sign-out leaves the shared stamp unchanged for a later renewal', async () => {
  const { locks, storage } = crossTabFixture();
  await assert.rejects(coordinateSessionLogout(async () => { throw new Error('logout failed'); },
    locks, storage, () => 'logout'), /logout failed/);
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), null);
});

test('a failed rotation leaves the next tab able to retry', async () => {
  const { locks, storage } = crossTabFixture();
  let calls = 0;
  const refresh = async () => {
    calls += 1;
    if (calls === 1) throw new Error('connection failed');
  };
  const results = await Promise.allSettled([
    coordinateSessionRefresh(refresh, locks, storage, () => 'failed'),
    coordinateSessionRefresh(refresh, locks, storage, () => 'succeeded'),
  ]);
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'fulfilled']);
  assert.equal(calls, 2);
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'succeeded');
});

test('unavailable shared storage still serializes refreshes without skipping them', async () => {
  const { locks } = crossTabFixture();
  let active = 0;
  let maximumActive = 0;
  const refresh = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
  };
  await Promise.all([
    coordinateSessionRefresh(refresh, locks, undefined),
    coordinateSessionRefresh(refresh, locks, undefined),
  ]);
  assert.equal(maximumActive, 1);
});

test('reactive tabs without shared storage probe the rotated cookie under the lock', async () => {
  const { locks } = crossTabFixture();
  let current = false;
  let refreshes = 0;
  let probes = 0;
  const refresh = async () => { refreshes += 1; current = true; };
  const isSessionCurrent = async () => { probes += 1; return current; };
  await Promise.all([
    coordinateSessionRefresh(refresh, locks, undefined, undefined, isSessionCurrent),
    coordinateSessionRefresh(refresh, locks, undefined, undefined, isSessionCurrent),
  ]);
  assert.equal(refreshes, 1);
  assert.equal(probes, 2);
});

test('reactive retry sees a proxy rotation even when the stored stamp is unchanged', async () => {
  const { locks, storage } = crossTabFixture();
  storage.setItem('charitypilot:session-refresh-stamp', 'older-browser-rotation');
  let refreshes = 0;
  let probes = 0;
  await coordinateSessionRefresh(
    async () => { refreshes += 1; }, locks, storage, undefined,
    async () => { probes += 1; return true; },
  );
  assert.equal(probes, 1);
  assert.equal(refreshes, 0);
});

test('reactive tabs avoid replay when a refresh succeeded but its stamp write failed', async () => {
  const { locks, storage } = crossTabFixture();
  storage.setItem('charitypilot:session-refresh-stamp', 'older-browser-rotation');
  const unwritableStorage = {
    getItem: storage.getItem,
    setItem: () => { throw new Error('storage unavailable'); },
  };
  let current = false;
  let refreshes = 0;
  await Promise.all([
    coordinateSessionRefresh(async () => { refreshes += 1; current = true; }, locks, unwritableStorage,
      undefined, async () => current),
    coordinateSessionRefresh(async () => { refreshes += 1; current = true; }, locks, unwritableStorage,
      undefined, async () => current),
  ]);
  assert.equal(refreshes, 1);
});

test('a failed session probe cannot present a possibly rotated refresh token', async () => {
  const { locks } = crossTabFixture();
  let refreshes = 0;
  await assert.rejects(
    coordinateSessionRefresh(
      async () => { refreshes += 1; },
      locks,
      undefined,
      undefined,
      async () => { throw new Error('session check unavailable'); },
    ),
    /session check unavailable/,
  );
  assert.equal(refreshes, 0);
});

test('proactive renewal still refreshes when no shared stamp exists', async () => {
  const { locks } = crossTabFixture();
  let refreshes = 0;
  await coordinateSessionRefresh(async () => { refreshes += 1; }, locks, undefined);
  assert.equal(refreshes, 1);
});

test('reactive retry without Web Locks skips a refresh after another tab rotated cookies', async () => {
  let refreshes = 0;
  let probes = 0;
  await coordinateSessionRefresh(
    async () => { refreshes += 1; },
    undefined,
    undefined,
    undefined,
    async () => { probes += 1; return true; },
  );
  assert.equal(probes, 1);
  assert.equal(refreshes, 0);
});

test('simultaneous expired tabs without Web Locks never present a refresh token', async () => {
  let refreshes = 0;
  const refresh = async () => { refreshes += 1; };
  const outcomes = await Promise.allSettled([
    coordinateSessionRefresh(refresh, undefined, undefined, undefined, async () => false),
    coordinateSessionRefresh(refresh, undefined, undefined, undefined, async () => false),
  ]);
  assert.ok(outcomes.every((outcome) => outcome.status === 'rejected'
    && outcome.reason instanceof SessionRefreshLockUnavailableError));
  assert.equal(refreshes, 0);
  await assert.rejects(
    coordinateSessionRefresh(refresh, undefined, undefined, undefined, async () => {
      throw new Error('session check unavailable');
    }),
    /session check unavailable/,
  );
  await assert.rejects(coordinateSessionRefresh(refresh, undefined, undefined),
    SessionRefreshLockUnavailableError);
  assert.equal(refreshes, 0);
});
