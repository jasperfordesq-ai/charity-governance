import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildConnectView,
  describeConfluencePublishing,
  describeConfluenceStatus,
  parseConfluenceSpaces,
  spaceLabel,
  CONFLUENCE_ALPHA_BADGE_LABEL,
  CONFLUENCE_DISCONNECT_COPY,
  CONFLUENCE_PUBLISH_SPACE_CHANGE_NOTE,
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
    publishSpace: null,
    publishing: false,
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

// ── connected is not publishing ─────────────────────────────────────────────

const GOVERNANCE = { id: 'space-gov', key: 'GOV', name: 'Governance' };

test('a connected organisation with no chosen space is told plainly that nothing is being published', () => {
  const view = describeConfluencePublishing(status({ status: 'CONNECTED' }));

  assert.equal(view.publishing, false);
  assert.equal(view.tone, 'warning', 'connected-without-a-space is a warning, not the green of a live connection');
  assert.match(view.headline, /not being published|nothing is being published/i);
  assert.ok(view.showSpacePicker, 'the screen must offer the step that is left');
  // The detail has to say what the charity should conclude: their documents
  // are NOT mirrored. A charity that believes it is mirroring and is not is
  // worse off than one that knows it has a step left.
  assert.match(String(view.detail), /choose|chosen/i);
  assert.match(String(view.detail), /only|not published/i);
});

test('publishing is only claimed when the connection, the flag and the space all agree', () => {
  const live = describeConfluencePublishing(
    status({ status: 'CONNECTED', publishSpace: GOVERNANCE, publishing: true }),
  );
  assert.equal(live.publishing, true);
  assert.equal(live.tone, 'success');
  assert.match(live.headline, /Governance \(GOV\)/);

  // Each ANDed condition dropped on its own. Any one of them missing means
  // the screen must not tell a charity its documents are being mirrored.
  const notClaimed = [
    { why: 'no space', value: status({ status: 'CONNECTED', publishSpace: null, publishing: true }) },
    { why: 'the API does not say publishing', value: status({ status: 'CONNECTED', publishSpace: GOVERNANCE }) },
    { why: 'the connection is not live', value: status({ status: 'ERROR', publishSpace: GOVERNANCE, publishing: true }) },
    {
      why: 'the connection was never made',
      value: status({ status: 'NOT_CONNECTED', publishSpace: GOVERNANCE, publishing: true }),
    },
    {
      why: 'the connection was disconnected',
      value: status({ status: 'DISCONNECTED', publishSpace: GOVERNANCE, publishing: true }),
    },
  ];
  for (const { why, value } of notClaimed) {
    const view = describeConfluencePublishing(value);
    assert.equal(view.publishing, false, `${why}: must not be reported as publishing`);
    assert.notEqual(view.tone, 'success', `${why}: must not wear the live-connection tone`);
  }
});

test('an organisation that never connected is not asked to choose a space', () => {
  const view = describeConfluencePublishing(status({ status: 'NOT_CONNECTED' }));
  assert.equal(view.showSpacePicker, false, 'there is nothing to list spaces from yet');
  assert.match(String(view.detail), /connect/i);
});

test('changing the space is stated never to move what was already published', () => {
  const view = describeConfluencePublishing(
    status({ status: 'CONNECTED', publishSpace: GOVERNANCE, publishing: true }),
  );
  assert.equal(view.detail, CONFLUENCE_PUBLISH_SPACE_CHANGE_NOTE);

  // The three things this note must keep saying. Each is a separate promise a
  // reassuring edit could quietly drop.
  assert.match(CONFLUENCE_PUBLISH_SPACE_CHANGE_NOTE, /from now on|future/i);
  assert.match(CONFLUENCE_PUBLISH_SPACE_CHANGE_NOTE, /already published/i);
  assert.match(CONFLUENCE_PUBLISH_SPACE_CHANGE_NOTE, /not moved|nothing is moved/i);
  // And it must never promise the opposite.
  assert.doesNotMatch(CONFLUENCE_PUBLISH_SPACE_CHANGE_NOTE, /will be moved|re-?published automatically/i);
});

test('a space reads as its name with its key, and as its key alone when unnamed', () => {
  assert.equal(spaceLabel(GOVERNANCE), 'Governance (GOV)');
  assert.equal(spaceLabel({ id: 'space-x', key: 'GOV', name: '' }), 'GOV');
  assert.equal(spaceLabel({ id: 'space-x', key: 'GOV', name: '   ' }), 'GOV');
});

test('parseConfluenceSpaces keeps only choosable spaces, and only three fields of them', () => {
  const parsed = parseConfluenceSpaces({
    spaces: [
      { id: 'space-gov', key: 'GOV', name: 'Governance', description: 'not ours to carry' },
      { id: 'space-noname', key: 'FIN' },
      { id: '', key: 'BAD' },
      { key: 'NOID' },
      { id: 'space-nokey' },
      null,
      'not a space',
    ],
  });

  assert.deepEqual(parsed, [
    { id: 'space-gov', key: 'GOV', name: 'Governance' },
    { id: 'space-noname', key: 'FIN', name: '' },
  ]);

  for (const payload of [null, undefined, {}, [], 'spaces', { spaces: 'not a list' }]) {
    assert.deepEqual(parseConfluenceSpaces(payload), [], `${JSON.stringify(payload) ?? 'undefined'} yields no spaces`);
  }
});

test('the integrations page shows the publishing state and the space picker from this module', () => {
  const src = readDash('integrations/page.tsx');
  assert.ok(
    src.includes('describeConfluencePublishing'),
    'the page must take its publishing state from this module, not decide it inline',
  );
  assert.ok(
    src.includes('CONFLUENCE_PUBLISH_SPACE_CHANGE_NOTE') || src.includes('publishing.detail'),
    'the page must render the note about what changing the space does not do',
  );
  assert.ok(
    src.includes('/integrations/confluence/publish-space'),
    'the page must be able to save the chosen space',
  );
  assert.ok(
    src.includes('/integrations/confluence/spaces'),
    'the chosen space must be picked from the spaces the API lists, never typed in',
  );
});
