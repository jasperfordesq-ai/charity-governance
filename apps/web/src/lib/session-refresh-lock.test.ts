import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinateSessionEstablishment, coordinateSessionLogout, coordinateSessionRefresh,
  markSessionEstablished,
  SessionReauthenticationRequiredError, SessionRefreshLockUnavailableError } from './session-refresh-lock';

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
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'logout:logout');
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
  await signingOut;
  await assert.rejects(refreshing, SessionReauthenticationRequiredError);
  assert.equal(refreshes, 0);
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'logout:logout');
});

test('sign-out persists its cross-tab fence before sending the revocation request', async () => {
  const { locks, storage } = crossTabFixture();
  let started!: () => void;
  let finishLogout!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const logoutGate = new Promise<void>((resolve) => { finishLogout = resolve; });
  const signingOut = coordinateSessionLogout(async () => {
    started();
    await logoutGate;
  }, locks, storage, () => 'before-request');
  await requestStarted;
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'logout:before-request');
  finishLogout();
  await signingOut;
});

test('ambiguous sign-out failure still fences a queued refresh of a possibly revoked cookie', async () => {
  const { locks, storage } = crossTabFixture();
  let failLogout!: () => void;
  const responseLost = new Promise<void>((_resolve, reject) => {
    failLogout = () => reject(new Error('logout response lost after server revocation'));
  });
  const signingOut = coordinateSessionLogout(() => responseLost, locks, storage, () => 'logout-attempt');
  await Promise.resolve();
  let refreshes = 0;
  const waitingRefresh = coordinateSessionRefresh(async () => { refreshes += 1; },
    locks, storage, () => 'rotation');
  failLogout();
  await assert.rejects(signingOut, /logout response lost/);
  await assert.rejects(waitingRefresh, SessionReauthenticationRequiredError);
  assert.equal(refreshes, 0);
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'logout:logout-attempt');
  await assert.rejects(coordinateSessionRefresh(async () => { refreshes += 1; },
    locks, storage, () => 'later'), SessionReauthenticationRequiredError);
  assert.equal(refreshes, 0);
  markSessionEstablished(storage, () => 'new-login');
  await coordinateSessionRefresh(async () => { refreshes += 1; }, locks, storage, () => 'rotation');
  assert.equal(refreshes, 1);
});

test('a new login waits for logout and replaces its fence only after cookies are issued', async () => {
  const { locks, storage } = crossTabFixture();
  let finishLogout!: () => void;
  let logoutStarted!: () => void;
  const logoutGate = new Promise<void>((resolve) => { finishLogout = resolve; });
  const started = new Promise<void>((resolve) => { logoutStarted = resolve; });
  const signingOut = coordinateSessionLogout(async () => {
    logoutStarted();
    await logoutGate;
  }, locks, storage, () => 'old-session');
  await started;
  let loginRequests = 0;
  const signingIn = coordinateSessionEstablishment(async () => {
    loginRequests += 1;
    return 'new-session';
  }, locks, storage, () => 'new-session');
  assert.equal(loginRequests, 0);
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'logout:old-session');
  finishLogout();
  await signingOut;
  assert.equal(await signingIn, 'new-session');
  assert.equal(loginRequests, 1);
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'login:new-session');
});

test('a failed login cannot clear the logout fence', async () => {
  const { locks, storage } = crossTabFixture();
  storage.setItem('charitypilot:session-refresh-stamp', 'logout:old-session');
  await assert.rejects(coordinateSessionEstablishment(async () => {
    throw new Error('bad credentials');
  }, locks, storage), /bad credentials/);
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'logout:old-session');
});

test('without Web Locks, an old logout cannot overwrite a newer login stamp', async () => {
  const { storage } = crossTabFixture();
  let finishLogout!: () => void;
  const logoutGate = new Promise<void>((resolve) => { finishLogout = resolve; });
  const signingOut = coordinateSessionLogout(() => logoutGate, undefined, storage,
    () => 'old-session');
  await coordinateSessionEstablishment(async () => 'new-session', undefined, storage,
    () => 'new-session');
  finishLogout();
  await signingOut;
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'login:new-session');
});

test('logout retries a transient fence-write failure before releasing its lock', async () => {
  const { locks, storage } = crossTabFixture();
  let writes = 0;
  const flakyStorage = {
    getItem: storage.getItem,
    setItem: (key: string, value: string) => {
      writes += 1;
      if (writes === 1) throw new Error('transient storage failure');
      storage.setItem(key, value);
    },
  };
  await coordinateSessionLogout(async () => undefined, locks, flakyStorage,
    () => 'revoked');
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'logout:revoked');
});

test('an uncertain refresh response requires a new login before any later renewal', async () => {
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
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
  assert.equal(calls, 1);
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'refresh-uncertain:failed');
  await assert.rejects(coordinateSessionRefresh(refresh, locks, storage, () => 'later'),
    SessionReauthenticationRequiredError);
  assert.equal(calls, 1);
  markSessionEstablished(storage, () => 'new-login');
  await coordinateSessionRefresh(refresh, locks, storage, () => 'succeeded');
  assert.equal(calls, 2);
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'succeeded');
});

test('a received pre-rotation rate limit can be retried without replaying a spent token', async () => {
  const { locks, storage } = crossTabFixture();
  let calls = 0;
  const refresh = async () => {
    calls += 1;
    if (calls === 1) throw { response: { status: 429 } };
  };
  const safeRefusal = (error: unknown) =>
    (error as { response?: { status?: number } })?.response?.status === 429;
  await assert.rejects(coordinateSessionRefresh(refresh, locks, storage, () => 'limited',
    undefined, safeRefusal));
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'refresh-refused:limited');
  await coordinateSessionRefresh(refresh, locks, storage, () => 'rotated', undefined, safeRefusal);
  assert.equal(calls, 2);
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'rotated');
});

test('a tab queued behind a safe refusal still attempts its own renewal', async () => {
  const { locks, storage } = crossTabFixture();
  let calls = 0;
  const refresh = async () => {
    calls += 1;
    if (calls === 1) throw { response: { status: 429 } };
  };
  const safeRefusal = (error: unknown) =>
    (error as { response?: { status?: number } })?.response?.status === 429;
  const results = await Promise.allSettled([
    coordinateSessionRefresh(refresh, locks, storage, () => 'limited', undefined, safeRefusal),
    coordinateSessionRefresh(refresh, locks, storage, () => 'rotated', undefined, safeRefusal),
  ]);
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'fulfilled']);
  assert.equal(calls, 2);
  assert.equal(storage.getItem('charitypilot:session-refresh-stamp'), 'rotated');
});

test('unavailable shared storage fails closed instead of presenting a possibly spent token', async () => {
  const { locks } = crossTabFixture();
  let refreshes = 0;
  await assert.rejects(coordinateSessionRefresh(async () => { refreshes += 1; },
    locks, undefined), SessionRefreshLockUnavailableError);
  assert.equal(refreshes, 0);
});

test('reactive retry without shared storage accepts a current access session but not an expired one', async () => {
  const { locks } = crossTabFixture();
  let refreshes = 0;
  let probes = 0;
  const refresh = async () => { refreshes += 1; };
  await coordinateSessionRefresh(refresh, locks, undefined, undefined,
    async () => { probes += 1; return true; });
  await assert.rejects(coordinateSessionRefresh(refresh, locks, undefined, undefined,
    async () => { probes += 1; return false; }), SessionRefreshLockUnavailableError);
  assert.equal(refreshes, 0);
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

test('an unwritable shared stamp blocks refresh before presenting the cookie', async () => {
  const { locks, storage } = crossTabFixture();
  storage.setItem('charitypilot:session-refresh-stamp', 'older-browser-rotation');
  const unwritableStorage = {
    getItem: storage.getItem,
    setItem: () => { throw new Error('storage unavailable'); },
  };
  let refreshes = 0;
  await assert.rejects(coordinateSessionRefresh(async () => { refreshes += 1; }, locks,
    unwritableStorage, undefined, async () => false), SessionRefreshLockUnavailableError);
  assert.equal(refreshes, 0);
});

test('an unreadable shared stamp blocks refresh before presenting the cookie', async () => {
  const { locks } = crossTabFixture();
  let refreshes = 0;
  await assert.rejects(coordinateSessionRefresh(async () => { refreshes += 1; }, locks,
    { getItem: () => { throw new Error('read blocked'); }, setItem: () => undefined }),
  SessionRefreshLockUnavailableError);
  assert.equal(refreshes, 0);
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
  const { locks, storage } = crossTabFixture();
  let refreshes = 0;
  await coordinateSessionRefresh(async () => { refreshes += 1; }, locks, storage);
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
