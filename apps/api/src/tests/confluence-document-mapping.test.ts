import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES } from '../services/confluence-pages.js';
import {
  CHARITYPILOT_PROPERTY_KEY,
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
