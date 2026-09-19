import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildConnectView,
  describeConfluenceStatus,
  CONFLUENCE_ALPHA_BADGE_LABEL,
  CONFLUENCE_DISCONNECT_COPY,
  type ConfluenceConnectionStatus,
  type ConfluenceStatusResponse,
} from './integration-status';

const AUTHORIZATION_URL = 'https://auth.atlassian.com/authorize?client_id=abc&state=xyz';

const VALID_DISCLOSURE = {
  stage: 'alpha',
  headline: 'Confluence is an alpha integration. Read these limits before you connect.',
  erasure: ['Erasure is best-effort and bounded by permissions you control.'],
  disconnecting: [
    'Disconnecting deletes CharityPilot’s copy of your credentials — verifiable.',
    'The grant lapses at Atlassian after 90 days without use, or you can remove CharityPilot in your ' +
      'Atlassian connected-apps settings.',
  ],
  reference: 'docs/ARCHITECTURE.md — "What document erasure can and cannot prove"',
};

// ── buildConnectView: the disclosure is the gate ────────────────────────────

test('buildConnectView returns a view carrying the disclosure alongside the authorize link', () => {
  const view = buildConnectView({ authorizationUrl: AUTHORIZATION_URL, disclosure: VALID_DISCLOSURE });

  assert.equal(view.authorizationUrl, AUTHORIZATION_URL);
  assert.equal(view.headline, VALID_DISCLOSURE.headline);
  assert.deepEqual(view.erasurePoints, VALID_DISCLOSURE.erasure);
  assert.deepEqual(view.disconnectingPoints, VALID_DISCLOSURE.disconnecting);
  assert.equal(view.reference, VALID_DISCLOSURE.reference);
  assert.ok(view.headline.length > 0, 'the connect screen has no authorize link without a disclosure to show first');
});

// Asserted against the object-shape guard's OWN message, not merely that
// something threw. `''`, `null` and `[]` are all caught a second time
// downstream by the completeness check (and `null` by a bare TypeError), so a
// bare `assert.throws` reads as coverage of a guard it never actually
// reaches: removing the guard entirely used to leave this test green.
const MISSING_DISCLOSURE = /buildConnectView requires a disclosure\./;

test('the connect screen cannot show the authorize link without the disclosure', () => {
  for (const disclosure of ['', null, undefined, [], ['not', 'an', 'object'], 'a plain string', 0]) {
    assert.throws(
      () => buildConnectView({ authorizationUrl: AUTHORIZATION_URL, disclosure }),
      MISSING_DISCLOSURE,
      `a disclosure of ${JSON.stringify(disclosure) ?? 'undefined'} must be refused by the shape guard itself`,
    );
  }
});

// Every ANDed sub-condition of the disclosure-completeness check, mutated
// independently by dropping exactly one required field per case.
test('buildConnectView refuses a disclosure missing any one required part', () => {
  const cases: Array<[string, unknown]> = [
    ['not an object', 'a plain string is not a disclosure'],
    ['an array', ['not', 'an', 'object']],
    ['missing headline', { ...VALID_DISCLOSURE, headline: undefined }],
    ['empty headline', { ...VALID_DISCLOSURE, headline: '   ' }],
    ['missing erasure', { ...VALID_DISCLOSURE, erasure: undefined }],
    ['empty erasure array', { ...VALID_DISCLOSURE, erasure: [] }],
    ['erasure with a blank entry', { ...VALID_DISCLOSURE, erasure: ['  '] }],
    ['missing disconnecting', { ...VALID_DISCLOSURE, disconnecting: undefined }],
    ['empty disconnecting array', { ...VALID_DISCLOSURE, disconnecting: [] }],
    ['disconnecting with a blank entry', { ...VALID_DISCLOSURE, disconnecting: ['  '] }],
  ];

  for (const [label, disclosure] of cases) {
    assert.throws(
      () => buildConnectView({ authorizationUrl: AUTHORIZATION_URL, disclosure }),
      `expected a disclosure that is ${label} to be refused`,
    );
  }
});

test('buildConnectView refuses a missing or non-https authorizationUrl even with a complete disclosure', () => {
  const cases: Array<[string, unknown]> = [
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['http, not https', 'http://auth.atlassian.com/authorize'],
    ['not a URL at all', 'not-a-url'],
  ];

  for (const [label, authorizationUrl] of cases) {
    assert.throws(
      () => buildConnectView({ authorizationUrl, disclosure: VALID_DISCLOSURE }),
      `expected an authorizationUrl that is ${label} to be refused`,
    );
  }
});

// ── the disconnect copy: what disconnecting does and does not do ───────────

test('the disconnect copy never claims we revoked access at Atlassian', () => {
  assert.doesNotMatch(CONFLUENCE_DISCONNECT_COPY, /we (have )?revoked|access (has been )?revoked/i);
  assert.match(CONFLUENCE_DISCONNECT_COPY, /90 days/);
  assert.match(CONFLUENCE_DISCONNECT_COPY, /connected[- ]apps/i);
});

test('the disconnect copy still says our own credential deletion is provable', () => {
  assert.match(CONFLUENCE_DISCONNECT_COPY, /delete/i);
  assert.match(CONFLUENCE_DISCONNECT_COPY, /verifiable|complete and verifiable|provable/i);
});

test('the disconnect copy attributes the 90-day lapse to Atlassian, not to a CharityPilot guarantee', () => {
  assert.match(CONFLUENCE_DISCONNECT_COPY, /Atlassian/);
  assert.doesNotMatch(CONFLUENCE_DISCONNECT_COPY, /CharityPilot guarantees|guaranteed by CharityPilot/i);
});

// ── the alpha marking ────────────────────────────────────────────────────────

test('the alpha badge label says alpha', () => {
  assert.match(CONFLUENCE_ALPHA_BADGE_LABEL, /alpha/i);
});

// ── describeConfluenceStatus: table-driven over every status the API sends ──

function status(overrides: Partial<ConfluenceStatusResponse>): ConfluenceStatusResponse {
  return {
    provider: 'CONFLUENCE',
    status: 'NOT_CONNECTED',
    siteUrl: null,
    siteName: null,
    siteCount: null,
    connectedAt: null,
    lastError: null,
    ...overrides,
  };
}

const STATUS_CASES: Array<{
  status: ConfluenceConnectionStatus;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  showConnect: boolean;
  showDisconnect: boolean;
}> = [
  { status: 'CONNECTED', tone: 'success', showConnect: false, showDisconnect: true },
  { status: 'ERROR', tone: 'danger', showConnect: true, showDisconnect: true },
  { status: 'DISCONNECTED', tone: 'neutral', showConnect: true, showDisconnect: false },
  { status: 'NOT_CONNECTED', tone: 'neutral', showConnect: true, showDisconnect: false },
];

test('describeConfluenceStatus maps every connection status to the right tone and actions', () => {
  for (const expected of STATUS_CASES) {
    const display = describeConfluenceStatus(status({ status: expected.status }));
    assert.equal(display.tone, expected.tone, `status ${expected.status}: wrong tone`);
    assert.equal(display.showConnect, expected.showConnect, `status ${expected.status}: wrong showConnect`);
    assert.equal(display.showDisconnect, expected.showDisconnect, `status ${expected.status}: wrong showDisconnect`);
    assert.ok(display.label.length > 0, `status ${expected.status}: label should not be empty`);
  }
});

// ── wiring: the page and navigation actually use these, not their own copies ─

const WEB = process.cwd(); // apps/web
const dashPath = (p: string) => join(WEB, 'src', 'app', '(dashboard)', p);
const readDash = (p: string) => readFileSync(dashPath(p), 'utf8');
const lib = (p: string) => readFileSync(join(WEB, 'src', 'lib', p), 'utf8');

test('the integrations page exists and is wired to this module, not to its own copies', () => {
  const pagePath = dashPath('integrations/page.tsx');
  assert.ok(existsSync(pagePath), 'apps/web/src/app/(dashboard)/integrations/page.tsx should exist');

  const src = readDash('integrations/page.tsx');
  assert.match(src, /from '@\/lib\/integration-status'/);
  assert.ok(src.includes('buildConnectView'), 'the page must gate the authorize link through buildConnectView');

  // `includes('buildConnectView')` alone would be satisfied by a page that
  // calls it AND ALSO renders `res.data.authorizationUrl` somewhere else. So
  // every live reference to an authorize URL in the page has to come off the
  // gated view object — a second, ungated render path fails here.
  const authorizeRefs = src
    .split(/\r?\n/)
    .filter((line) => line.includes('authorizationUrl'))
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    });
  assert.ok(authorizeRefs.length > 0, 'the page should render an authorize link at all');
  for (const line of authorizeRefs) {
    assert.match(
      line,
      /connectView\.authorizationUrl/,
      `every authorize URL must come from the gated view, but found: ${line.trim()}`,
    );
  }
  assert.ok(
    src.includes('CONFLUENCE_DISCONNECT_COPY'),
    'the page must render the shared disconnect copy, not text of its own',
  );
  assert.ok(
    src.includes('CONFLUENCE_ALPHA_BADGE_LABEL'),
    'the page must mark Confluence as alpha using the shared label',
  );

  // The page itself must never claim a revocation, independently of the
  // shared constant's own guard above.
  assert.doesNotMatch(src, /we (have )?revoked|access (has been )?revoked/i);
});

test('the callback page links back to /integrations, and that route now exists', () => {
  const callbackSrc = readDash('integrations/confluence/callback/page.tsx');
  assert.match(callbackSrc, /href="\/integrations"/);
});

test('the dashboard navigation lists Integrations and marks it alpha', () => {
  const layoutSrc = readDash('layout.tsx');
  assert.match(layoutSrc, /href:\s*'\/integrations'/);
  assert.ok(
    layoutSrc.includes('CONFLUENCE_ALPHA_BADGE_LABEL') || /alpha/i.test(layoutSrc),
    'the navigation entry should mark Confluence as alpha so it cannot be reached by accident',
  );
});

test('/integrations is a protected app route requiring an auth cookie', () => {
  const src = lib('protected-routes.ts');
  assert.match(src, /'\/integrations'/);
});
