import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ATLASSIAN_DENIED_MESSAGE,
  runConfluenceCallbackOnce,
  scrubCallbackUrlSecrets,
  type CallbackUrlWindow,
  type ConfluenceCallbackPageDeps,
} from './confluence-callback-page';
import type { CallbackOutcome } from './confluence-callback';

const LIVE_CODE = 'LIVE-AUTHORIZATION-CODE';
const LIVE_STATE = 'LIVE-OAUTH-STATE';

function fakeWindow(href: string): CallbackUrlWindow & { replaced: string[] } {
  const replaced: string[] = [];
  return {
    replaced,
    location: { href },
    history: {
      state: { pageKey: 'callback' },
      replaceState(_state: unknown, _unused: string, url: string) {
        replaced.push(url);
      },
    },
  };
}

type Recorder = {
  events: string[];
  exchanged: Array<{ code: string; state: string }>;
  outcomes: CallbackOutcome[];
  deps: ConfluenceCallbackPageDeps;
};

function recorder(params: Record<string, string>, outcome?: CallbackOutcome): Recorder {
  const events: string[] = [];
  const exchanged: Array<{ code: string; state: string }> = [];
  const outcomes: CallbackOutcome[] = [];

  return {
    events,
    exchanged,
    outcomes,
    deps: {
      getParam: (name) => params[name] ?? null,
      scrubUrl: () => {
        events.push('scrub');
      },
      exchange: async (input) => {
        events.push('exchange');
        exchanged.push(input);
        return outcome ?? { kind: 'connected' };
      },
      setOutcome: (value) => {
        outcomes.push(value);
      },
    },
  };
}

// ── 1. the URL is scrubbed, and before the code is ever spent ───────────────

test('the callback URL is scrubbed before the authorization code is exchanged', async () => {
  const run = recorder({ code: LIVE_CODE, state: LIVE_STATE });

  runConfluenceCallbackOnce({ current: false }, run.deps);
  await Promise.resolve();

  assert.deepEqual(
    run.events,
    ['scrub', 'exchange'],
    'the secrets must leave the address bar before the exchange, so a throwing exchange cannot leave them there',
  );
  assert.deepEqual(run.exchanged, [{ code: LIVE_CODE, state: LIVE_STATE }]);
});

test('the scrub removes code, state and error from the URL without losing the rest of it', () => {
  const win = fakeWindow(
    `https://app.charitypilot.ie/integrations/confluence/callback?code=${LIVE_CODE}&state=${LIVE_STATE}&error=access_denied&keep=me`,
  );

  scrubCallbackUrlSecrets(win);

  assert.equal(win.replaced.length, 1, 'exactly one history entry is replaced');
  const scrubbed = win.replaced[0];
  assert.equal(scrubbed.includes(LIVE_CODE), false, scrubbed);
  assert.equal(scrubbed.includes(LIVE_STATE), false, scrubbed);
  assert.equal(scrubbed.includes('access_denied'), false, scrubbed);
  assert.match(scrubbed, /\/integrations\/confluence\/callback/);
  assert.match(scrubbed, /keep=me/);
});

test('the scrub is a no-op on the server rather than throwing', () => {
  assert.doesNotThrow(() => scrubCallbackUrlSecrets(undefined));
});

// ── 2. the exchange runs at most once ──────────────────────────────────────

test('a StrictMode double mount never spends the authorization code twice', async () => {
  const run = recorder({ code: LIVE_CODE, state: LIVE_STATE });
  // One `useRef` shared by both effect runs of the same component instance,
  // which is exactly what React hands a double-mounted effect.
  const ranRef = { current: false };

  runConfluenceCallbackOnce(ranRef, run.deps);
  runConfluenceCallbackOnce(ranRef, run.deps);
  await Promise.resolve();

  assert.equal(run.exchanged.length, 1, 'a second POST would spend an already-spent code');
  assert.deepEqual(run.events, ['scrub', 'exchange']);
});

test('a fresh mount with its own ref does run, so the guard is not a module-level latch', async () => {
  const run = recorder({ code: LIVE_CODE, state: LIVE_STATE });

  runConfluenceCallbackOnce({ current: false }, run.deps);
  runConfluenceCallbackOnce({ current: false }, run.deps);
  await Promise.resolve();

  assert.equal(run.exchanged.length, 2);
});

// ── 3. an Atlassian denial never reaches the exchange ──────────────────────

test('an Atlassian denial reports a fixed message and never spends anything', async () => {
  const run = recorder({ error: 'access_denied', state: LIVE_STATE });

  runConfluenceCallbackOnce({ current: false }, run.deps);
  await Promise.resolve();

  assert.deepEqual(run.exchanged, [], 'there is nothing to exchange when Atlassian refused');
  assert.deepEqual(run.outcomes, [{ kind: 'failed', message: ATLASSIAN_DENIED_MESSAGE }]);
  // The URL is still scrubbed: `error` is as unwelcome in the address bar as
  // the code, and a denial can still carry a `state`.
  assert.deepEqual(run.events, ['scrub']);
});

test('an Atlassian denial is refused even when a code is also present', async () => {
  const run = recorder({ error: 'access_denied', code: LIVE_CODE, state: LIVE_STATE });

  runConfluenceCallbackOnce({ current: false }, run.deps);
  await Promise.resolve();

  assert.deepEqual(run.exchanged, []);
  assert.equal(run.outcomes[0]?.kind, 'failed');
});

test('a missing code or a missing state is refused without an exchange', async () => {
  const cases: Array<Record<string, string>> = [{ state: LIVE_STATE }, { code: LIVE_CODE }, {}];
  for (const params of cases) {
    const run = recorder(params);
    runConfluenceCallbackOnce({ current: false }, run.deps);
    await Promise.resolve();

    assert.deepEqual(run.exchanged, [], JSON.stringify(params));
    assert.deepEqual(run.outcomes, [{ kind: 'failed', message: ATLASSIAN_DENIED_MESSAGE }]);
  }
});

test('the outcome of a real exchange is handed back to the page unchanged', async () => {
  const spent: CallbackOutcome = { kind: 'code-spent', message: 'already used' };
  const run = recorder({ code: LIVE_CODE, state: LIVE_STATE }, spent);

  runConfluenceCallbackOnce({ current: false }, run.deps);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(run.outcomes, [spent]);
});

// ── the page must actually be wired to this module ─────────────────────────

test('the callback page runs its effect through this module, not a copy of its own', () => {
  const pagePath = join(
    process.cwd(),
    'src',
    'app',
    '(dashboard)',
    'integrations',
    'confluence',
    'callback',
    'page.tsx',
  );
  assert.ok(existsSync(pagePath), `${pagePath} should exist`);

  const src = readFileSync(pagePath, 'utf8');
  assert.match(src, /from '@\/lib\/confluence-callback-page'/);
  assert.ok(
    src.includes('runConfluenceCallbackOnce'),
    'the page must run the guarded effect body from this module',
  );
  assert.ok(
    src.includes('confluenceCallbackPageDeps'),
    'the page must take the real scrub and the real exchange from this module',
  );
  // A page that called the exchange itself would bypass the scrub and the
  // double-mount guard entirely, and this file could not see it.
  assert.doesNotMatch(src, /completeConfluenceCallback\s*\(/);
  assert.doesNotMatch(src, /history\.replaceState/);
});
