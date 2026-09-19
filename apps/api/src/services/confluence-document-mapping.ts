import { getPrimaryFrontendOrigin } from '../utils/frontend-origin.js';

/**
 * Maps a CharityPilot governance document onto the page Confluence will hold
 * for it — its title, its body, and the content-property metadata attached to
 * it. Nothing here calls Confluence; it only decides *what* the publish
 * worker (Task 6) will send.
 *
 * ## Why the title carries the whole create-or-adopt guarantee
 *
 * `createPage` (`confluence-pages.ts`) is deliberately non-idempotent: a
 * retried create after a dropped connection or a 429 produces two pages for
 * one board resolution, with nothing saying which is real. The worker
 * survives a retry by re-reading `findPageByTitle` and adopting whatever it
 * finds — and that only works if {@link publicationTitle} is:
 *
 * - **Deterministic** — the same document always yields the same title, on
 *   every attempt, forever. It is a pure function of `doc.id` and `doc.name`
 *   and touches nothing else (no clock, no random id, no environment).
 * - **Collision-free across documents** — two different documents must never
 *   produce the same title, or a retry would adopt the *wrong* page and
 *   attach one charity's file to another document's page. The document id is
 *   always appended, and CharityPilot document ids are unique primary keys,
 *   so two distinct documents can never collide even when their names are
 *   identical (two documents both named "Safeguarding Policy" get two
 *   different titles).
 *
 * ## Content property vs. page body — different jobs, different limits
 *
 * The DPO's sign-off is explicit: the definitive record of what a Board
 * approved stays in CharityPilot. Confluence gets a **mirror**, and both the
 * property and the body respect that:
 *
 * - {@link publicationProperty} is indexing/integration metadata only —
 *   enough to correlate the page back to the CharityPilot record (id,
 *   version, organisation, a reference) — never the approval itself. It must
 *   also stay well inside Phase 3's `CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES`
 *   (32 KB) ceiling, so every string field is length-capped before encoding,
 *   independent of whatever CharityPilot itself currently allows on that
 *   field.
 * - {@link publicationBody} is a wrapper page: it names the document, points
 *   back to CharityPilot, and says plainly that the attachment — not this
 *   page — is the document. It must never become a copy of the document's
 *   substance.
 */
export type PublicationDocument = {
  id: string;
  name: string;
  version: number;
  organisationId: string;
  category: string;
  boardMinuteReference?: string | null;
  approvedDate?: Date | string | null;
  nextReviewDate?: Date | string | null;
};

/** The one key CharityPilot ever writes on a published page. */
export const CHARITYPILOT_PROPERTY_KEY = 'charitypilot.governance';

const TITLE_ID_MARKER = 'CharityPilot doc';

/**
 * Where a charity's own naming convention belongs, if one is ever confirmed.
 *
 * The DPO's Governance Hub *reportedly* prefixes policies `POL -` and
 * standard operating procedures `NOS -` — but that has never been seen
 * against a real site, and guessing at it produces pages that look native
 * and are subtly wrong, which is worse than pages that are obviously ours.
 * So this returns the document name unchanged, and matching a real
 * convention later is a one-line edit to *this function only*.
 *
 * `publicationTitle` always appends the CharityPilot document id after
 * whatever this returns, so determinism and cross-document uniqueness never
 * depend on this function's output — only on `doc.id` and `doc.name`, which
 * this function must not drop.
 */
export function conventionalDocumentName(doc: { id: string; name: string; category?: string }): string {
  return doc.name;
}

/**
 * The page title for `doc`. Deterministic and collision-free — see the module
 * header. Two different documents named identically get two different
 * titles because the id is always appended; the same document always gets
 * the same title because this is a pure function of `doc.id` and `doc.name`.
 */
export function publicationTitle(doc: { id: string; name: string }): string {
  const displayName = conventionalDocumentName(doc);
  return `${displayName} (${TITLE_ID_MARKER} ${doc.id})`;
}

/**
 * Confluence storage format is XHTML. A document name is user input, and two
 * independent defenses stand between it and markup a hostile or merely
 * careless name could break:
 *
 * - XML forbids most C0 control characters even when entity-escaped (only
 *   tab, LF and CR are legal), so they are stripped first.
 * - The five XML metacharacters are then entity-escaped, so `<`, `&` and
 *   quotes in a name cannot open a tag, start an entity, or break out of an
 *   attribute value.
 */
// C0 control code points XML forbids even when entity-escaped: everything
// below 0x20 except tab (0x09), LF (0x0A) and CR (0x0D). Written as decimal
// code-point comparisons rather than a "\\uXXXX" regex character class,
// because that literal escape-sequence text has previously round-tripped
// through this exact file into literal raw control bytes on disk (a real NUL
// byte among them) instead of staying as escape-sequence *text* — invisible
// in most editors, and enough to make some tools (this repository's own
// `sed`/`grep` included) misdetect the file as binary. Numeric comparison
// cannot suffer that failure mode.
function isDisallowedXmlControlCodePoint(codePoint: number): boolean {
  return codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d;
}

function stripDisallowedXmlControlChars(value: string): string {
  let result = '';
  for (const char of value) {
    if (!isDisallowedXmlControlCodePoint(char.codePointAt(0) ?? 0)) result += char;
  }
  return result;
}

function escapeXhtmlText(value: string): string {
  return stripDisallowedXmlControlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The page body for `doc`, as Confluence storage-format XHTML.
 *
 * This is a wrapper, not the document: the attachment Task 6 uploads is the
 * governance record, and the page's job is only to display it and point back
 * to CharityPilot, which the text below says explicitly. Every interpolated
 * value — the document name most of all, since it is user input — goes
 * through {@link escapeXhtmlText}.
 */
export function publicationBody(doc: PublicationDocument): string {
  const documentsUrl = `${getPrimaryFrontendOrigin()}/documents`;

  const name = escapeXhtmlText(doc.name);
  const version = escapeXhtmlText(String(doc.version));
  const id = escapeXhtmlText(doc.id);
  const href = escapeXhtmlText(documentsUrl);
  const linkText = escapeXhtmlText(documentsUrl);

  return (
    '<p>This page is a <strong>published copy</strong> maintained by CharityPilot. ' +
    'The file attached to this page is the governance document; this page is a wrapper ' +
    'that displays it and points back to the authoritative record.</p>' +
    `<p><strong>Document:</strong> ${name} (version ${version})</p>` +
    `<p><strong>CharityPilot reference:</strong> ${id}</p>` +
    '<p>The approval record — what a Board approved, when, and under what resolution — ' +
    'remains the responsibility of CharityPilot and is not duplicated on this page. ' +
    `View it in <a href="${href}">${linkText}</a>.</p>`
  );
}

// Generous ceilings for a "correlate by", chosen to be far larger than any
// value needed to find a document again, and far smaller than would ever
// threaten CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES (32 KB) even before the
// property's fixed-size fields (id, version, organisationId, dates) are
// added. CharityPilot's own upload path currently caps a document's `name`
// at a 4 KB multipart field, but that cap lives in a route validator, not in
// this module or the database column (`TEXT`, unbounded) — this module does
// not trust that cap to hold forever, and truncates independently of it.
const NAME_CORRELATION_MAX_CHARS = 300;
const REFERENCE_CORRELATION_MAX_CHARS = 200;

/** Truncates on code points, not UTF-16 code units, so a surrogate pair is never split. */
function truncateForProperty(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, maxChars).join('')}…`;
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * The content-property value for `doc`: `≤ 32 KB` of JSON, and — per the
 * DPO's sign-off — indexing/integration metadata only. It carries the
 * CharityPilot document id, its version, its organisation, and enough else to
 * correlate a page back to the CharityPilot record. It never carries the
 * approval itself (no resolution text, no narrative, no evidentiary detail):
 * that record of truth stays in CharityPilot.
 *
 * Every string field is length-capped before this returns, independent of
 * whatever length CharityPilot itself currently permits on that field, so a
 * document with maximal field lengths still serialises far under the 32 KB
 * ceiling `confluence-pages.ts` enforces at write time. This returns a plain
 * value for `JSON.stringify` to encode — never a hand-built JSON string — so
 * a name containing `<`, `&`, quotes or a control character is escaped
 * exactly as `JSON.stringify` escapes any other string, and cannot break the
 * property's JSON.
 */
export function publicationProperty(doc: PublicationDocument): unknown {
  return {
    schemaVersion: 1,
    charityPilot: {
      documentId: doc.id,
      documentVersion: doc.version,
      organisationId: doc.organisationId,
      documentName: truncateForProperty(doc.name, NAME_CORRELATION_MAX_CHARS),
      category: doc.category,
      boardMinuteReference:
        doc.boardMinuteReference == null
          ? null
          : truncateForProperty(doc.boardMinuteReference, REFERENCE_CORRELATION_MAX_CHARS),
      approvedDate: toIsoOrNull(doc.approvedDate),
      nextReviewDate: toIsoOrNull(doc.nextReviewDate),
    },
  };
}
