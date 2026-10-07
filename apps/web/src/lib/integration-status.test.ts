import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  allMirrorCopy,
  buildConnectView,
  describeConfluenceMirror,
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

// ───────────────────────────────────────────────────────────────────────────
// The mirror copy, and the one word it may never contain.
// ───────────────────────────────────────────────────────────────────────────

test('no sentence about a Confluence page ever says "deleted"', () => {
  const copy = allMirrorCopy();
  assert.ok(copy.length >= 12, `this guard proves nothing over ${copy.length} strings`);

  for (const sentence of copy) {
    // v2 answers 404 for a trashed page AND a purged one. Only the v1 trashed
    // read tells them apart, and one is restorable by the charity in thirty
    // seconds while the other is not restorable by anyone. "Deleted" collapses
    // that, and a governance product telling a trustee their policy was deleted
    // when it is sitting in their own trash has told them something false about
    // a governance record.
    assert.doesNotMatch(
      sentence,
      /delet/i,
      `mirror copy must never say "deleted": ${JSON.stringify(sentence)}`,
    );
  }
});

test('a published copy of a non-current document is flagged for separate review', () => {
  const mirror = { publication: 'PUBLISHED' as const, pageUrl: 'https://example.invalid/page', remote: null };
  const current = describeConfluenceMirror(mirror);
  const historical = describeConfluenceMirror(mirror, false);
  assert.equal(current.label, 'Published');
  assert.equal(historical.label, 'Historical copy recorded');
  assert.equal(historical.tone, 'warning');
  assert.match(historical.historicalReview ?? '', /not CURRENT.*manage that copy separately/);

  const failedCopy = describeConfluenceMirror({ ...mirror, publication: 'FAILED' }, false);
  assert.equal(failedCopy.actionable, false);
  assert.match(failedCopy.detail, /cannot be retried/);
  assert.match(failedCopy.detail, /page reference was recorded/);
  assert.notEqual(failedCopy.label, 'Not published');
  const failedWithoutPage = describeConfluenceMirror({ publication: 'FAILED', pageRecorded: false, pageUrl: null, remote: null }, false);
  assert.equal(failedWithoutPage.actionable, false);
  assert.match(failedWithoutPage.historicalReview ?? '', /new publication is not permitted/);
});

test('the copy guard reads the real strings, not an empty list', () => {
  // The canary for the guard above: a refactor that made `allMirrorCopy`
  // return nothing would leave it green over zero sentences.
  const copy = allMirrorCopy();
  assert.ok(copy.some((sentence) => sentence.includes('trash')));
  assert.ok(copy.some((sentence) => sentence.includes('could not be found')));
});

test('a trashed page is described as restorable, by them, in their own site', () => {
  const display = describeConfluenceMirror({
    publication: 'PUBLISHED',
    pageUrl: null,
    remote: {
      state: 'TRASHED',
      title: 'Safeguarding Policy',
      version: 3,
      lastReconciledAt: '2026-09-20T09:00:00.000Z',
      reconcileError: null,
    },
  });

  assert.match(display.detail, /trash/);
  assert.match(display.detail, /restored/);
  assert.equal(display.actionable, true, 'there is something the charity can do about this one');
  assert.match(display.detail, /2026-09-20/, 'a reader must know how fresh this is');
});

test('a page that could not be found says exactly that, and claims nothing more', () => {
  const display = describeConfluenceMirror({
    publication: 'PUBLISHED',
    pageUrl: null,
    remote: {
      state: 'GONE',
      title: null,
      version: null,
      lastReconciledAt: '2026-09-20T09:00:00.000Z',
      reconcileError: null,
    },
  });

  // CharityPilot polled and could not find it. It cannot witness who removed
  // it, or whether it is recoverable by some route it cannot see.
  assert.match(display.detail, /could not be found/);
  assert.equal(display.actionable, false);
  assert.doesNotMatch(display.detail, /permanent|forever|unrecoverable/i);
});

test('an unreadable page is reported as unknown, not as absent', () => {
  const display = describeConfluenceMirror({
    publication: 'PUBLISHED',
    pageUrl: null,
    remote: {
      state: 'UNKNOWN',
      title: null,
      version: null,
      lastReconciledAt: null,
      reconcileError: 'CONFLUENCE_PAGE_FORBIDDEN',
    },
  });

  assert.match(display.detail, /unknown/i);
  // The difference between "we looked and it is gone" and "we were not allowed
  // to look" is the difference between a governance incident and a permissions
  // problem.
  assert.doesNotMatch(display.detail, /no longer/i);
});

test('a published page that has never been checked does not claim to have been', () => {
  const display = describeConfluenceMirror({
    publication: 'PUBLISHED',
    pageUrl: null,
    remote: null,
  });

  assert.match(display.detail, /not been checked/);
  assert.equal(display.tone, 'positive');
});

test('a retired publication explains that the Confluence page was left alone', () => {
  const display = describeConfluenceMirror({ publication: 'RETIRED', pageUrl: null, remote: null });

  // The owner's 2026-09-19 ruling, in the one place a trustee would ever meet
  // it: an ordinary deletion here does not touch the charity's own site.
  assert.match(display.detail, /left in place/);
  assert.match(display.detail, /own site/);
});

test('a failed publication tells an administrator there is something to do', () => {
  const display = describeConfluenceMirror({ publication: 'FAILED', pageRecorded: false, pageUrl: null, remote: null });

  assert.equal(display.tone, 'danger');
  assert.equal(display.actionable, true);
  assert.match(display.detail, /try again/);
  assert.match(display.detail, /before CharityPilot recorded/);
});

test('a recorded page remains explicit when publishing stops before completion', () => {
  const mirror = { publication: 'FAILED' as const, pageUrl: 'https://example.invalid/page', remote: null };
  const display = describeConfluenceMirror(mirror);
  assert.equal(display.label, 'Page reference recorded');
  assert.match(display.detail, /did not finish/);
  assert.match(display.detail, /external page and attachment/);
  assert.equal(display.actionable, true);

  const pending = describeConfluenceMirror({ ...mirror, publication: 'PENDING' });
  assert.match(pending.detail, /page reference has been recorded/);
  assert.match(pending.detail, /has not finished/);

  const withoutSiteAddress = describeConfluenceMirror({ publication: 'FAILED', pageRecorded: true, pageUrl: null, remote: null });
  assert.equal(withoutSiteAddress.label, 'Page reference recorded');
  assert.match(withoutSiteAddress.detail, /page reference was recorded/);

  const unknown = describeConfluenceMirror({ publication: 'FAILED', pageUrl: null, remote: null });
  assert.match(unknown.detail, /cannot establish whether/);
  assert.doesNotMatch(unknown.detail, /before CharityPilot recorded/);
});

test('an ambiguous remote write cannot offer an ordinary retry', () => {
  const display = describeConfluenceMirror({ publication: 'FAILED', writeOutcomeUnknown: true,
    pageRecorded: false, pageUrl: null, remote: null });
  assert.equal(display.actionable, false);
  assert.equal(display.label, 'Publishing outcome unclear');
  assert.match(display.detail, /page or attachment write may have completed/);
  assert.match(display.detail, /reconciled/);
});

test('a page on another Confluence site is not shown as a current healthy copy or retryable job', () => {
  const oldSite = { pageRecorded: true, pageSiteMatchesConnection: false, pageUrl: null,
    remote: { state: 'VISIBLE' as const, title: null, version: 2,
      lastReconciledAt: '2026-09-27T10:00:00.000Z', reconcileError: null } };
  const published = describeConfluenceMirror({ ...oldSite, publication: 'PUBLISHED' });
  assert.equal(published.label, 'Page on another site');
  assert.equal(published.tone, 'warning');
  assert.match(published.detail, /different site.*current connection/);
  assert.doesNotMatch(published.detail, /checked 2026-09-27/);

  const failed = describeConfluenceMirror({ ...oldSite, publication: 'FAILED' });
  assert.equal(failed.actionable, false);
  assert.match(failed.detail, /reconcile the recorded page before retrying/);

  const historical = describeConfluenceMirror({ ...oldSite, publication: 'FAILED' }, false);
  assert.equal(historical.actionable, false);
  assert.match(historical.historicalReview ?? '', /manage that copy on the original site/);
  assert.match(historical.detail, /different site/);

  const disconnected = describeConfluenceMirror({ ...oldSite, publication: 'PUBLISHED',
    pageSiteMatchesConnection: null, connectionAvailable: false });
  assert.equal(disconnected.label, 'Connection unavailable');
  assert.equal(disconnected.tone, 'warning');
  assert.match(disconnected.detail, /no active Confluence connection/);
  const disconnectedHistorical = describeConfluenceMirror({ ...oldSite, publication: 'FAILED',
    pageSiteMatchesConnection: null, connectionAvailable: false }, false);
  assert.equal(disconnectedHistorical.actionable, false);
  assert.match(disconnectedHistorical.historicalReview ?? '', /connection is inactive/);

  const unknownSite = describeConfluenceMirror({ ...oldSite, publication: 'PUBLISHED',
    pageSiteMatchesConnection: null, connectionAvailable: true });
  assert.equal(unknownSite.label, 'Page site unverified');
  assert.equal(unknownSite.actionable, false);
  assert.match(unknownSite.detail, /cannot confirm.*currently connected site/);
});

test('a changed publication destination asks for reapproval and never offers retry', () => {
  const mirror = { publication: 'PENDING' as const, pageRecorded: false, pageUrl: null, remote: null };
  const display = describeConfluenceMirror(mirror, true, true);
  assert.equal(display.label, 'Publication approval needs review');
  assert.equal(display.tone, 'warning');
  assert.equal(display.actionable, false);
  assert.match(display.detail, /site or space.*not covered/);
  const failed = describeConfluenceMirror({ ...mirror, publication: 'FAILED' }, true, true);
  assert.equal(failed.actionable, false);
  assert.equal(failed.label, 'Publication approval needs review');
});

test('a recorded page is not shown as healthy after publication approval is withdrawn', () => {
  const display = describeConfluenceMirror({ publication: 'PUBLISHED', pageRecorded: true,
    pageUrl: null, remote: { state: 'VISIBLE', title: null, version: 2,
      lastReconciledAt: '2026-09-27T10:00:00.000Z', reconcileError: null } }, true, false, true);
  assert.equal(display.label, 'Publication approval withdrawn');
  assert.equal(display.tone, 'warning');
  assert.equal(display.actionable, false);
  assert.match(display.detail, /page reference remains.*no current publication approval/);
  assert.doesNotMatch(display.detail, /page is gone\./);
});

test('a document never published says so without implying a page exists', () => {
  for (const mirror of [null, { publication: 'NOT_PUBLISHED' as const, pageUrl: null, remote: null }]) {
    const display = describeConfluenceMirror(mirror);
    assert.equal(display.label, 'Not published');
    assert.match(display.detail, /CharityPilot only/);
  }
});

test('an unparseable check date is omitted rather than rendered as Invalid Date', () => {
  const display = describeConfluenceMirror({
    publication: 'PUBLISHED',
    pageUrl: null,
    remote: {
      state: 'VISIBLE',
      title: null,
      version: null,
      lastReconciledAt: 'not-a-date',
      reconcileError: null,
    },
  });

  assert.doesNotMatch(display.detail, /Invalid Date|NaN/);
  assert.equal(display.detail, 'Published to Confluence.');
});
