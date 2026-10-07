import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api } from './api';
import {
  loadDocumentMirrors,
  parseDocumentMirror,
  parseDocumentMirrors,
  MIRROR_REQUEST_MAX_IDS,
} from './document-mirrors';

function validMirror(overrides: Record<string, unknown> = {}) {
  return {
    publication: 'PUBLISHED',
    pageRecorded: true,
    pageSiteMatchesConnection: true,
    recordedPageMatchesDestination: true,
    connectionAvailable: true,
    approvalDestinationCurrent: true,
    publishDestination: { siteId: 'site-1', siteUrl: 'https://charity.atlassian.net',
      spaceId: 'space-1', spaceKey: 'GOV', spaceName: 'Governance' },
    pageUrl: 'https://charity.atlassian.net/wiki/pages/viewpage.action?pageId=page-1',
    remote: {
      state: 'VISIBLE',
      title: 'Safeguarding Policy',
      version: 3,
      lastReconciledAt: '2026-09-20T09:00:00.000Z',
      reconcileError: null,
    },
    ...overrides,
  };
}

test('a well-formed mirror parses whole', () => {
  const mirror = parseDocumentMirror(validMirror());

  assert.equal(mirror?.publication, 'PUBLISHED');
  assert.equal(mirror?.pageRecorded, true);
  assert.equal(mirror?.pageSiteMatchesConnection, true);
  assert.equal(mirror?.recordedPageMatchesDestination, true);
  assert.equal(mirror?.connectionAvailable, true);
  assert.equal(mirror?.approvalDestinationCurrent, true);
  assert.equal(mirror?.publishDestination?.spaceName, 'Governance');
  assert.equal(mirror?.remote?.state, 'VISIBLE');
  assert.equal(mirror?.remote?.version, 3);
});

test('recorded page survives a missing site URL and an older response stays uncertain', () => {
  assert.equal(parseDocumentMirror(validMirror({ publication: 'FAILED', pageUrl: null }))?.pageRecorded, true);
  assert.equal(parseDocumentMirror(validMirror({ publication: 'FAILED', pageUrl: null,
    pageSiteMatchesConnection: false }))?.pageSiteMatchesConnection, false);
  assert.equal(parseDocumentMirror(validMirror({ publication: 'FAILED', pageUrl: null,
    connectionAvailable: false }))?.connectionAvailable, false);
  assert.equal(parseDocumentMirror(validMirror({ approvalDestinationCurrent: false }))?.approvalDestinationCurrent, false);
  assert.equal(parseDocumentMirror(validMirror({ publishDestination: { siteId: 'site-1', spaceId: '' } }))?.publishDestination, null);
  const oldResponse = validMirror({ publication: 'FAILED', pageUrl: null });
  delete (oldResponse as { pageRecorded?: unknown }).pageRecorded;
  delete (oldResponse as { pageSiteMatchesConnection?: unknown }).pageSiteMatchesConnection;
  delete (oldResponse as { recordedPageMatchesDestination?: unknown }).recordedPageMatchesDestination;
  delete (oldResponse as { connectionAvailable?: unknown }).connectionAvailable;
  delete (oldResponse as { approvalDestinationCurrent?: unknown }).approvalDestinationCurrent;
  delete (oldResponse as { publishDestination?: unknown }).publishDestination;
  assert.equal(parseDocumentMirror(oldResponse)?.pageRecorded, null);
  assert.equal(parseDocumentMirror(oldResponse)?.pageSiteMatchesConnection, null);
  assert.equal(parseDocumentMirror(oldResponse)?.recordedPageMatchesDestination, null);
  assert.equal(parseDocumentMirror(oldResponse)?.connectionAvailable, null);
  assert.equal(parseDocumentMirror(oldResponse)?.approvalDestinationCurrent, null);
  assert.equal(parseDocumentMirror(oldResponse)?.publishDestination, null);
  assert.equal(parseDocumentMirror(validMirror({ pageRecorded: false }))?.pageRecorded, true,
    'a present page URL is evidence even if the flag is contradictory');
  assert.equal(parseDocumentMirror(validMirror({ pageSiteMatchesConnection: false }))?.pageSiteMatchesConnection, true,
    'a URL is constructed only when the API has a matching connected site');
});

test('an ambiguous remote write remains flagged after parsing', () => {
  const mirror = parseDocumentMirror(validMirror({ publication: 'FAILED',
    writeOutcomeUnknown: true }));
  assert.equal(mirror?.writeOutcomeUnknown, true);
});

test('a publication state this build has never heard of is dropped, not rendered', () => {
  // A future API value must not reach a trustee's screen as though this build
  // understood it.
  assert.equal(parseDocumentMirror(validMirror({ publication: 'SOMETHING_NEW' })), null);
  assert.equal(parseDocumentMirror(validMirror({ publication: 42 })), null);
  assert.equal(parseDocumentMirror(null), null);
  assert.equal(parseDocumentMirror([]), null);
});

test('an unrecognised remote state reads as not-checked, never as one of ours', () => {
  const mirror = parseDocumentMirror(
    validMirror({ remote: { state: 'SOMETHING_NEW', title: null, version: null } }),
  );

  // Showing the wrong one of TRASHED and GONE is the single worst thing this
  // screen can do, so an unknown value becomes "not checked" rather than being
  // coerced into a neighbour.
  assert.equal(mirror?.publication, 'PUBLISHED');
  assert.equal(mirror?.remote, null);
});

test('the mirrors payload becomes a map keyed by document id', () => {
  const mirrors = parseDocumentMirrors({
    mirrors: {
      'doc-1': validMirror(),
      'doc-2': validMirror({ publication: 'NOT_PUBLISHED', remote: null, pageUrl: null }),
      'doc-3': { publication: 'NONSENSE' },
    },
  });

  assert.deepEqual([...mirrors.keys()].sort(), ['doc-1', 'doc-2']);
  assert.equal(mirrors.get('doc-2')?.publication, 'NOT_PUBLISHED');
});

test('a malformed payload is an empty map, not a throw', () => {
  for (const payload of [null, undefined, [], 'nope', {}, { mirrors: [] }, { mirrors: null }]) {
    assert.equal(parseDocumentMirrors(payload).size, 0, `for ${JSON.stringify(payload)}`);
  }
});

// ---------------------------------------------------------------------------
// The load contract: the documents list must never fall over because of this.
// ---------------------------------------------------------------------------

test('a failed mirror read resolves empty rather than throwing', async () => {
  const original = api.get;
  api.get = (async () => {
    throw new Error('network down');
  }) as typeof api.get;

  try {
    const mirrors = await loadDocumentMirrors(['doc-1']);
    // A network failure, a 500 or a logged-out session must not take the
    // documents list down with it. An empty map renders no chips, which is the
    // honest degradation: "we could not ask" is not "there is no page".
    assert.equal(mirrors.size, 0);
  } finally {
    api.get = original;
  }
});

test('no documents means no request at all', async () => {
  const original = api.get;
  let called = 0;
  api.get = (async () => {
    called += 1;
    return { data: { mirrors: {} } };
  }) as unknown as typeof api.get;

  try {
    assert.equal((await loadDocumentMirrors([])).size, 0);
    assert.equal((await loadDocumentMirrors(['', ''])).size, 0);
    assert.equal(called, 0);
  } finally {
    api.get = original;
  }
});

test('ids are sent as one comma-separated request, bounded to the API cap', async () => {
  const original = api.get;
  const requests: Array<Record<string, unknown>> = [];
  api.get = (async (_url: string, config?: { params?: Record<string, unknown> }) => {
    requests.push(config?.params ?? {});
    return { data: { mirrors: {} } };
  }) as unknown as typeof api.get;

  try {
    const ids = Array.from({ length: MIRROR_REQUEST_MAX_IDS + 20 }, (_, i) => `doc-${i}`);
    await loadDocumentMirrors(ids);

    assert.equal(requests.length, 1, 'a page of documents must be one request, not N');
    const sent = String(requests[0].ids).split(',');
    // Bounded on this side as well as the API's: an unbounded list from a
    // screen is a way to ask the database for the whole table.
    assert.equal(sent.length, MIRROR_REQUEST_MAX_IDS);
  } finally {
    api.get = original;
  }
});

// ---------------------------------------------------------------------------
// Wiring. The logic above is worth nothing if no screen renders it.
// ---------------------------------------------------------------------------

const WEB_SRC = join(process.cwd(), 'src');

function source(relative: string): string {
  return readFileSync(join(WEB_SRC, relative), 'utf8');
}

test('the documents list renders the mirror chip', () => {
  const panel = source('app/(dashboard)/documents/document-list-panel.tsx');
  assert.match(panel, /<ConfluenceMirrorChip/, 'the chip must actually be rendered');
  assert.match(panel, /mirror=\{mirrors\.get\(doc\.id\)\}/, 'per document, keyed by its own id');
});

test('the documents workflow loads mirrors after the documents, not instead of them', () => {
  const workflow = source('app/(dashboard)/documents/use-documents-workflow.ts');
  // `setDocuments` first: a mirror read that somehow blocked would otherwise
  // delay the list it is decorating.
  const setDocumentsAt = workflow.indexOf('setDocuments(loaded)');
  const loadMirrorsAt = workflow.indexOf('loadDocumentMirrors(loaded.map');
  assert.ok(setDocumentsAt > 0, 'documents must be set from the loaded list');
  assert.ok(loadMirrorsAt > setDocumentsAt, 'mirrors are loaded after the documents are on screen');
});

test('the retry button is wired to the retry endpoint', () => {
  const workflow = source('app/(dashboard)/documents/use-documents-workflow.ts');
  assert.match(workflow, /\/publication\/retry/);
  const chip = source('components/governance/confluence-mirror-chip.tsx');
  assert.match(chip, /onRetry/);
});

/** Source with comments removed, so a guard scans code rather than prose about it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the chip writes no state copy of its own', () => {
  const chip = source('components/governance/confluence-mirror-chip.tsx');

  // Every sentence about a Confluence page comes from `describeConfluenceMirror`,
  // which the "never say deleted" guard scans. Copy written inline here would
  // sit outside that guard entirely.
  assert.match(chip, /describeConfluenceMirror/);

  // Comments are stripped first, and the reason is worth stating: the
  // component's own header explains the "never say deleted" rule and therefore
  // contains the word, which turned this guard red on its first run. Scanning
  // prose about the rule instead of the code it governs would leave the guard
  // unable to coexist with its own explanation.
  const code = withoutComments(chip);
  assert.doesNotMatch(code, /delet/i);
  assert.doesNotMatch(code, /No longer visible/i, 'state copy belongs in the guarded library');
  assert.doesNotMatch(code, /trash/i);
});

test('the comment-stripping the guard relies on actually strips', () => {
  // Canary: a `withoutComments` that returned its input unchanged would make
  // the guard above scan the header again and fail, but one that returned an
  // empty string would make it pass over nothing.
  const stripped = withoutComments(source('components/governance/confluence-mirror-chip.tsx'));
  assert.ok(stripped.includes('describeConfluenceMirror'), 'code must survive');
  assert.ok(!stripped.includes('DELIBERATELY THIN'), 'comments must not');
});

test('the external Confluence link cannot reach back through window.opener', () => {
  const chip = source('components/governance/confluence-mirror-chip.tsx');
  assert.match(chip, /rel="noopener noreferrer"/);
});
