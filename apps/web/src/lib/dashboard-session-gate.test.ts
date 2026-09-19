import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dashboardBody, dashboardRedirect } from './dashboard-session-gate';

const LIVE_CODE = 'LIVE-AUTHORIZATION-CODE';
const LIVE_STATE = 'LIVE-OAUTH-STATE';

const CALLBACK_PATH = '/integrations/confluence/callback';
const CALLBACK_SEARCH = `?code=${LIVE_CODE}&state=${LIVE_STATE}`;

// The exact dead-session condition, driven for real: the auth context has
// finished loading and resolved to no user. That is what `!isLoading && !user`
// means in the layout, and it is reachable without waiting out the refresh TTL
// because refresh-token family revocation fires on reuse or logout.
const DEAD_SESSION = { isLoading: false, user: null } as const;
const UNVERIFIED_SESSION = { isLoading: false, user: { emailVerified: false } } as const;
const LIVE_SESSION = { isLoading: false, user: { emailVerified: true } } as const;
const STILL_LOADING = { isLoading: true, user: null } as const;

/** Everything the layout would act on, so a leak into either half is caught. */
function everythingTheLayoutWouldDo(
  session: { isLoading: boolean; user: { emailVerified: boolean } | null },
  location: { pathname: string; search: string },
): string {
  return [
    `redirect: ${dashboardRedirect(session, location)}`,
    `body: ${dashboardBody(session, location.pathname)}`,
  ].join('\n');
}

// ── the leak ────────────────────────────────────────────────────────────────
//
// Before this module the layout answered a dead session with
//   router.replace(`/login?next=${encodeURIComponent(pathname + search)}`)
// reading `window.location.search` — which on this path still holds Atlassian's
// `?code=…&state=…`. The callback page's own scrub could not save it: the
// layout's `if (!user || !user.emailVerified) return null` runs before
// `{children}`, so on this exact trigger the page never mounts and the scrub
// never runs.

test('a dead session on the Confluence callback never redirects, and never surfaces the code', () => {
  const location = { pathname: CALLBACK_PATH, search: CALLBACK_SEARCH };

  assert.equal(
    dashboardRedirect(DEAD_SESSION, location),
    null,
    'the callback page renews the session itself — redirecting it abandons the connection',
  );

  const everything = everythingTheLayoutWouldDo(DEAD_SESSION, location);
  assert.equal(
    everything.includes(LIVE_CODE),
    false,
    `the live authorization code must appear nowhere the layout acts on:\n${everything}`,
  );
  assert.equal(everything.includes(LIVE_STATE), false, everything);
  assert.equal(everything.includes('/login'), false, everything);
});

test('a dead session on the Confluence callback still mounts the page, so it can renew the session', () => {
  assert.equal(
    dashboardBody(DEAD_SESSION, CALLBACK_PATH),
    'renew-in-place',
    'returning null here is what stopped the page running — and stopped it scrubbing its own URL',
  );
});

test('renew-in-place is granted only to a self-renewing path, never to the rest of the dashboard', () => {
  for (const pathname of ['/dashboard', '/documents', '/integrations', '/integrations/confluence']) {
    assert.equal(
      dashboardBody(DEAD_SESSION, pathname),
      'blank',
      `${pathname} must not render to a visitor with no usable session`,
    );
  }
});

// ── the second trigger ──────────────────────────────────────────────────────

test('an unverified session on the Confluence callback is not bounced to /verify-email either', () => {
  const location = { pathname: CALLBACK_PATH, search: CALLBACK_SEARCH };

  assert.equal(dashboardRedirect(UNVERIFIED_SESSION, location), null);
  assert.equal(dashboardBody(UNVERIFIED_SESSION, CALLBACK_PATH), 'renew-in-place');

  const everything = everythingTheLayoutWouldDo(UNVERIFIED_SESSION, location);
  assert.equal(everything.includes(LIVE_CODE), false, everything);
  assert.equal(everything.includes(LIVE_STATE), false, everything);
});

test('an unverified session anywhere else still goes to /verify-email', () => {
  assert.equal(
    dashboardRedirect(UNVERIFIED_SESSION, { pathname: '/dashboard', search: '' }),
    '/verify-email',
  );
  assert.equal(dashboardBody(UNVERIFIED_SESSION, '/dashboard'), 'blank');
});

// ── depth: every other path's `next` is scrubbed ────────────────────────────

test('a login redirect for any other path strips code and state out of next', () => {
  const destination = dashboardRedirect(DEAD_SESSION, {
    pathname: '/documents',
    search: `?view=board&code=${LIVE_CODE}&state=${LIVE_STATE}`,
  });

  assert.ok(destination, 'a dead session anywhere else must still reach /login');
  assert.equal(
    destination.includes(LIVE_CODE),
    false,
    `no single-use secret may be nested inside next: ${destination}`,
  );
  assert.equal(destination.includes(LIVE_STATE), false, destination);
  assert.equal(
    destination,
    `/login?next=${encodeURIComponent('/documents?view=board')}`,
  );
});

test('a login redirect still preserves the destination it is there to preserve', () => {
  assert.equal(
    dashboardRedirect(DEAD_SESSION, { pathname: '/compliance', search: '' }),
    `/login?next=${encodeURIComponent('/compliance')}`,
  );
});

// ── the states that must not change ────────────────────────────────────────

test('nothing is decided while the auth context is still loading', () => {
  assert.equal(
    dashboardRedirect(STILL_LOADING, { pathname: CALLBACK_PATH, search: CALLBACK_SEARCH }),
    null,
  );
  assert.equal(dashboardRedirect(STILL_LOADING, { pathname: '/dashboard', search: '' }), null);
  assert.equal(dashboardBody(STILL_LOADING, '/dashboard'), 'loading');
  assert.equal(dashboardBody(STILL_LOADING, CALLBACK_PATH), 'loading');
});

test('a verified session renders the dashboard and is never redirected', () => {
  assert.equal(dashboardRedirect(LIVE_SESSION, { pathname: '/dashboard', search: '' }), null);
  assert.equal(dashboardBody(LIVE_SESSION, '/dashboard'), 'dashboard');
  // Including on the callback path, which is the ordinary successful connect.
  assert.equal(dashboardBody(LIVE_SESSION, CALLBACK_PATH), 'dashboard');
});

// ── the layout must actually be wired to this module ───────────────────────

test('the dashboard layout decides through this module, not a copy of its own', () => {
  const layoutPath = join(process.cwd(), 'src', 'app', '(dashboard)', 'layout.tsx');
  assert.ok(existsSync(layoutPath), `${layoutPath} should exist`);

  const src = readFileSync(layoutPath, 'utf8');
  assert.match(src, /from '@\/lib\/dashboard-session-gate'/);
  assert.ok(src.includes('dashboardRedirect'), 'the layout must take its destination from this module');
  assert.ok(src.includes('dashboardBody'), 'the layout must take its render decision from this module');

  // The two shapes that reintroduce the leak: building the `next` value by
  // hand from the raw location, and returning null for every session this
  // module says should render in place. (Asserted against the construction
  // rather than the string `/login?next=`, which also appears in a comment
  // explaining why the layout no longer builds one.)
  assert.doesNotMatch(
    src,
    /encodeURIComponent/,
    'the layout must not encode a `next` value of its own — dashboardRedirect owns it',
  );
  assert.doesNotMatch(src, /router\.replace\(\s*`/, 'no interpolated redirect target in the layout');
  assert.doesNotMatch(src, /if \(!user \|\| !user\.emailVerified\) return null/);
  // The logout button's own plain redirect is unaffected and must survive.
  assert.match(src, /router\.replace\('\/login'\)/);
});
