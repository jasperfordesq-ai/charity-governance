import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES } from '../services/confluence-pages.js';
import {
  CHARITYPILOT_PROPERTY_KEY,
  PUBLICATION_TITLE_MAX_LENGTH,
  publicationBody,
  publicationProperty,
  publicationTitle,
  type PublicationDocument,
} from '../services/confluence-document-mapping.js';

function doc(overrides: Partial<PublicationDocument> & { id: string; name: string }): PublicationDocument {
  return {
    version: 1,
    organisationId: 'org-1',
    category: 'POLICY',
    boardMinuteReference: null,
    approvedDate: null,
    nextReviewDate: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// publicationTitle: determinism and cross-document collision-freedom
// ---------------------------------------------------------------------------

test('publicationTitle is deterministic: the same document produces the same title on repeated calls', () => {
  const d = doc({ id: 'doc-1', name: 'Safeguarding Policy' });

  const first = publicationTitle(d);
  const second = publicationTitle(d);
  const third = publicationTitle({ id: d.id, name: d.name });

  assert.equal(first, second);
  assert.equal(first, third);
});

test('publicationTitle gives two documents with an identical name two different titles', () => {
  // The exact collision the brief calls out: a charity with two documents
  // both named "Safeguarding Policy". Adoption depends on these never
  // matching, or a retry would attach one document's file to the other's page.
  const first = publicationTitle({ id: 'doc-1', name: 'Safeguarding Policy' });
  const second = publicationTitle({ id: 'doc-2', name: 'Safeguarding Policy' });

  assert.notEqual(first, second);
});

test('publicationTitle carries the document id somewhere in the title', () => {
  // Belt-and-braces on top of the collision test above: the id must actually
  // be *present*, not merely happen to produce a different string today for
  // some unrelated reason.
  const title = publicationTitle({ id: 'a-very-specific-id-123', name: 'Policy' });
  assert.ok(title.includes('a-very-specific-id-123'), `expected the document id in: ${title}`);
});

// ---------------------------------------------------------------------------
// publicationTitle: the length cap.
//
// Confluence's own practical page-title limit (~255 chars) is never let
// decide what happens to an over-limit title: a rejection would dead-letter
// the publish (loud, recoverable), but a silent truncation on Confluence's
// side would store a title different from the one this module computed, so
// the next attempt's findPageByTitle search (built from the FULL,
// un-truncated title) would find nothing and call the non-idempotent
// createPage again -- a second page for one board resolution. So the cap is
// enforced here, deterministically, before Confluence is ever asked.
// ---------------------------------------------------------------------------

const VERY_LONG_NAME = 'Safeguarding Policy for Vulnerable Adults and Children '.repeat(20);

test('publicationTitle caps a very long document name within PUBLICATION_TITLE_MAX_LENGTH', () => {
  const title = publicationTitle({ id: 'doc-1', name: VERY_LONG_NAME });
  assert.ok(
    title.length <= PUBLICATION_TITLE_MAX_LENGTH,
    `expected at most ${PUBLICATION_TITLE_MAX_LENGTH} characters, got ${title.length}`,
  );
});

test('publicationTitle stays deterministic for a very long document name', () => {
  const d = { id: 'doc-1', name: VERY_LONG_NAME };
  assert.equal(publicationTitle(d), publicationTitle(d));
  assert.equal(publicationTitle(d), publicationTitle({ id: d.id, name: d.name }));
});

test('publicationTitle gives two long documents sharing a long common prefix different titles', () => {
  // The case that matters most: naive truncation (cut the whole title to N
  // chars, id included) makes two documents collide exactly when their names
  // are similar -- which is exactly when a charity is most likely to have
  // both. Both names below are far longer than PUBLICATION_TITLE_MAX_LENGTH
  // and share a prefix that alone exceeds the cap, so a truncation-unaware
  // implementation would produce the identical truncated name for both.
  const sharedPrefix = 'Health and Safety Policy — Annual Review Edition — '.repeat(10);
  const first = publicationTitle({ id: 'doc-1', name: `${sharedPrefix}Site A` });
  const second = publicationTitle({ id: 'doc-2', name: `${sharedPrefix}Site B` });

  assert.notEqual(first, second);
  assert.ok(first.includes('doc-1'), `expected the id in: ${first}`);
  assert.ok(second.includes('doc-2'), `expected the id in: ${second}`);
});

// ---------------------------------------------------------------------------
// publicationTitle: normalisation.
//
// The same failure as the length cap above, in the other direction a store
// rewrites what it is handed. Every wiki trims a page title and collapses the
// whitespace inside it, and none of them stores a C0 control character in one.
// If this module computes a title a store will not hold verbatim, then the
// next attempt's findPageByTitle searches for a title nothing holds, finds
// nothing, and calls the non-idempotent createPage a second time -- a second
// page for one board resolution. So the title is normalised here, before
// Confluence is ever asked, and these tests are what keep it that way.
//
// Control characters are built with `String.fromCharCode` rather than a
// literal escape sequence, for the reason DANGEROUS_NAME gives below.
// ---------------------------------------------------------------------------

const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

/** Leading and trailing space, an internal newline and tab run, and a NUL. */
const UNTIDY_NAME = `  Safeguarding${LF}${TAB} ${NUL}Policy  `;

test('publicationTitle normalises a name carrying whitespace and a control character', () => {
  const title = publicationTitle({ id: 'doc-1', name: UNTIDY_NAME });

  assert.equal(title, 'Safeguarding Policy (CharityPilot doc doc-1)');
});

test('publicationTitle emits a title a page store would hold verbatim', () => {
  // Stated as the property rather than the literal, so it still holds if the
  // title's shape ever changes: what goes out must already equal what any
  // reasonable store would rewrite it to.
  const normalise = (value: string) => value.trim().replace(/\s+/g, ' ');
  const title = publicationTitle({ id: 'doc-1', name: UNTIDY_NAME });

  assert.equal(normalise(title), title, `a store would rewrite this title: ${JSON.stringify(title)}`);
  assert.equal(containsDisallowedXmlControlChar(title), false);
});

test('publicationTitle stays deterministic for an untrimmed name', () => {
  // Determinism is what adoption rests on, and normalisation must not cost it.
  const first = publicationTitle({ id: 'doc-1', name: UNTIDY_NAME });
  const second = publicationTitle({ id: 'doc-1', name: UNTIDY_NAME });

  assert.equal(first, second);
});

test('publicationTitle gives two documents whose names differ only in whitespace different titles', () => {
  // Collision-freedom survives normalisation because the id is what separates
  // two documents, not the name. Normalising the name portion can make two
  // names identical; the ids must still keep the titles apart.
  const first = publicationTitle({ id: 'doc-1', name: ' Safeguarding Policy' });
  const second = publicationTitle({ id: 'doc-2', name: 'Safeguarding  Policy ' });

  assert.notEqual(first, second);
  assert.ok(first.includes('doc-1'), `expected the id in: ${first}`);
  assert.ok(second.includes('doc-2'), `expected the id in: ${second}`);
});

test('publicationTitle never normalises the document id itself', () => {
  // The id is the whole of the collision-freedom guarantee, so normalisation
  // is applied to the name portion only and the id travels whole. An id is
  // never expected to carry whitespace; this pins that even if one did, it
  // would arrive intact rather than being quietly rewritten into another
  // document's id.
  const id = `doc${TAB}1`;
  const title = publicationTitle({ id, name: 'Safeguarding Policy' });

  assert.ok(title.includes(id), `expected the id verbatim in: ${JSON.stringify(title)}`);
});

test('publicationTitle still leads with the id marker when a name normalises away entirely', () => {
  // A name of nothing but whitespace passes uploadDocumentSchema's min(1) only
  // if the schema does not trim, and a title that began with a space would be
  // rewritten by the store -- the very failure this normalisation prevents.
  const title = publicationTitle({ id: 'doc-1', name: `${TAB} ${LF}` });

  assert.equal(title, '(CharityPilot doc doc-1)');
});

test('publicationTitle still respects PUBLICATION_TITLE_MAX_LENGTH after normalising', () => {
  const title = publicationTitle({ id: 'doc-1', name: `  ${VERY_LONG_NAME}${LF}${VERY_LONG_NAME}  ` });

  assert.ok(
    title.length <= PUBLICATION_TITLE_MAX_LENGTH,
    `expected at most ${PUBLICATION_TITLE_MAX_LENGTH} characters, got ${title.length}`,
  );
  assert.ok(title.includes('doc-1'), `expected the id in: ${title}`);
});

// ---------------------------------------------------------------------------
// publicationBody: escaping, and the body is a wrapper, not the document
// ---------------------------------------------------------------------------

// The control character is built with `String.fromCharCode` rather than a
// literal escape sequence in this source file: a `\uXXXX` escape here has
// previously round-tripped into a literal raw control byte on disk instead
// of staying as escape-sequence text, which made the file that held it look
// corrupted to ordinary text tools. `fromCharCode` cannot suffer that.
const DANGEROUS_NAME = `Policy </p><script>alert('x')</script> & "quoted" 'name'${String.fromCharCode(7)}end`;

/** True if `value` contains a C0 control character XML forbids even when entity-escaped. */
function containsDisallowedXmlControlChar(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) return true;
  }
  return false;
}

test('publicationBody escapes a name containing <, &, quotes and a control character', () => {
  const body = publicationBody(doc({ id: 'doc-1', name: DANGEROUS_NAME }));

  // Nothing from the dangerous name survives verbatim as markup: no raw tag,
  // no raw ampersand, no raw quote character, no raw control character.
  assert.ok(!body.includes('</p><script>'), 'a raw tag must not appear in the body');
  assert.ok(!body.includes("alert('x')") || body.includes('&#39;'), 'quotes must be escaped');
  assert.ok(!containsDisallowedXmlControlChar(body), 'no raw control character may remain');

  // The escaped form is present instead, proving the name was not simply
  // dropped.
  assert.ok(body.includes('&lt;/p&gt;&lt;script&gt;'), 'the tag must appear escaped');
  assert.ok(body.includes('&amp;'), 'the ampersand must appear escaped');
  assert.ok(body.includes('&quot;quoted&quot;'), 'double quotes must appear escaped');
  assert.ok(body.includes('&apos;name&apos;'), 'single quotes must appear escaped');
});

// The boundary that `isDisallowedXmlControlCodePoint`'s ANDed conditions
// exist to draw: every C0 control point below 0x20 is stripped from the body
// EXCEPT tab (0x09), LF (0x0A) and CR (0x0D), which XML allows even unescaped
// and which a document name legitimately carrying a line break must not lose.
// Each removed control character below is stripped for a *different* one of
// the `!==` conditions, so a mutation that deletes any single condition shows
// up as exactly one of these disallowed characters surviving.
const ALLOWED_CONTROL_CHARS = [0x09, 0x0a, 0x0d];
const DISALLOWED_CONTROL_CHARS = [0x00, 0x08, 0x0b, 0x0c, 0x0e, 0x1f];

test('publicationBody strips disallowed C0 control characters but keeps tab, LF and CR', () => {
  for (const codePoint of ALLOWED_CONTROL_CHARS) {
    const marker = `before${String.fromCharCode(codePoint)}after`;
    const body = publicationBody(doc({ id: 'doc-1', name: marker }));
    assert.ok(body.includes(marker), `code point 0x${codePoint.toString(16)} must survive unstripped`);
  }

  for (const codePoint of DISALLOWED_CONTROL_CHARS) {
    const withChar = `before${String.fromCharCode(codePoint)}after`;
    const body = publicationBody(doc({ id: 'doc-1', name: withChar }));
    assert.ok(!containsDisallowedXmlControlChar(body), `code point 0x${codePoint.toString(16)} must be stripped`);
    assert.ok(body.includes('beforeafter'), `code point 0x${codePoint.toString(16)} must be removed, not replaced`);
  }

  // The boundary itself: 0x1F is the highest disallowed point, 0x20 (space)
  // is the lowest one that must never be touched.
  const atBoundary = publicationBody(doc({ id: 'doc-1', name: 'before\x20after' }));
  assert.ok(atBoundary.includes('before after'), 'space (0x20) must never be stripped');
});

test('publicationBody names the document and links back to CharityPilot, not the document content', () => {
  const body = publicationBody(doc({ id: 'doc-1', name: 'Data Protection Policy', version: 3 }));

  assert.ok(body.includes('Data Protection Policy'));
  assert.ok(body.includes('version 3'));
  assert.ok(body.includes('doc-1'));
  assert.ok(/<a href="https?:\/\/[^"]+">/.test(body), 'expected a link back to CharityPilot');
  assert.ok(
    /published copy/i.test(body) && /attached/i.test(body),
    'the body must say the attachment is the document and this page is a wrapper',
  );
});

// ---------------------------------------------------------------------------
// publicationProperty: metadata only, valid JSON even for a dangerous name,
// and always well under the 32 KB ceiling
// ---------------------------------------------------------------------------

test('CHARITYPILOT_PROPERTY_KEY is the documented literal key', () => {
  assert.equal(CHARITYPILOT_PROPERTY_KEY, 'charitypilot.governance');
});

test('publicationProperty carries the document id, version and organisation for correlation', () => {
  const property = publicationProperty(
    doc({ id: 'doc-1', name: 'Policy', version: 4, organisationId: 'org-42', category: 'POLICY' }),
  ) as { charityPilot: Record<string, unknown> };

  assert.equal(property.charityPilot.documentId, 'doc-1');
  assert.equal(property.charityPilot.documentVersion, 4);
  assert.equal(property.charityPilot.organisationId, 'org-42');
  assert.equal(property.charityPilot.category, 'POLICY');
});

test('publicationProperty never carries the approval as the record of truth', () => {
  // Nothing in the shape names a resolution's narrative text or an
  // "approved" boolean the eraser or an auditor could mistake for the
  // authoritative decision. Only a reference string and dates, for
  // correlation, per the DPO's sign-off.
  const property = publicationProperty(
    doc({
      id: 'doc-1',
      name: 'Policy',
      boardMinuteReference: 'Minute 12(a), 2026-01-10 meeting',
      approvedDate: new Date('2026-01-10T00:00:00.000Z'),
    }),
  ) as { charityPilot: Record<string, unknown> };

  const keys = Object.keys(property.charityPilot);
  for (const forbidden of ['resolutionText', 'approvalNarrative', 'approved', 'isApproved']) {
    assert.ok(!keys.includes(forbidden), `property must not carry "${forbidden}"`);
  }
  assert.equal(property.charityPilot.boardMinuteReference, 'Minute 12(a), 2026-01-10 meeting');
  assert.equal(property.charityPilot.approvedDate, '2026-01-10T00:00:00.000Z');
});

test('publicationProperty serialises a name with <, &, quotes and a control character to valid, round-trippable JSON', () => {
  const property = publicationProperty(doc({ id: 'doc-1', name: DANGEROUS_NAME }));

  const serialised = JSON.stringify(property);
  assert.equal(typeof serialised, 'string');

  const parsed = JSON.parse(serialised) as { charityPilot: { documentName: string } };
  assert.equal(parsed.charityPilot.documentName, DANGEROUS_NAME);
});

test('publicationProperty stays well under the 32 KB ceiling for a maximal document', () => {
  // "Maximal" independent of whatever CharityPilot's own upload validator
  // currently permits (a 4 KB multipart field for `name`, no limit at all in
  // the database column): every string field here is padded far past that,
  // to prove this module's own truncation is what keeps the property small,
  // not a cap that happens to live somewhere else in the codebase today.
  const maximal = doc({
    id: 'c'.repeat(64),
    name: 'x'.repeat(50_000),
    organisationId: 'o'.repeat(64),
    category: 'POLICY',
    boardMinuteReference: 'r'.repeat(50_000),
    approvedDate: new Date('2026-01-01T00:00:00.000Z'),
    nextReviewDate: new Date('2027-01-01T00:00:00.000Z'),
  });

  const bytes = Buffer.byteLength(JSON.stringify(publicationProperty(maximal)), 'utf8');

  assert.ok(bytes < CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES / 4, `expected well under the ceiling, got ${bytes} bytes`);
});
