import { DOCUMENT_UPLOAD_MAX_FILE_SIZE } from '../routes/documents/document-upload-validation.js';
import { AppError } from '../utils/errors.js';
import type { ConfluenceClient } from './confluence-client.js';

/**
 * Attachment operations, built on the HTTP core in `confluence-client.ts`.
 *
 * A governance document is usually a *file* — a signed policy PDF, a minute
 * book extract — so this module is how the substance of a charity's record
 * actually reaches its Confluence site. Pages carry the narrative; this carries
 * the evidence.
 *
 * ## Why this one module spans two API versions
 *
 * **Confluence's v2 attachment endpoints are GET and DELETE only. There is no
 * v2 upload.** Atlassian has never shipped one. So:
 *
 * - `listAttachments` uses **v2** — `GET /wiki/api/v2/pages/{id}/attachments`.
 * - `uploadAttachment` uses **v1** — `POST /wiki/rest/api/content/{id}/child/attachment`,
 *   multipart, and carrying `X-Atlassian-Token: nocheck`.
 *
 * This looks like an inconsistency somebody forgot to finish, and it is not.
 * **Do not "tidy" the upload onto v2.** There is nothing on v2 to tidy it onto,
 * and the result of trying is that a charity can no longer publish a signed
 * policy — which fails at the far end, in a charity's site, rather than here.
 *
 * `X-Atlassian-Token: nocheck` is equally load-bearing: without it Atlassian
 * refuses the request as a suspected CSRF attempt. It is not optional, not a
 * legacy relic, and not something to drop because the rest of the client does
 * not send it. The 403 handling below exists because a proxy that strips it
 * produces a failure nobody would otherwise be able to read.
 *
 * ## The flag that matters
 *
 * `uploadAttachment` is issued **non-idempotent**. Uploading the same filename
 * twice to one page does not create a duplicate attachment — Confluence makes a
 * *new version* of the existing one — which is milder than the duplicate-page
 * hazard the core was built around, but is still a change to a charity's
 * auditable record made by accident. An upload whose outcome is unknown is the
 * caller's to reconcile (list the page's attachments), not the core's to guess.
 */

/** The shape callers get back, identical for both API versions. */
export type ConfluenceAttachment = {
  id: string;
  title: string;
  mediaType: string;
  fileSize: number;
  downloadUrl: string;
};

export type UploadAttachmentInput = {
  pageId: string;
  filename: string;
  /** The MIME type recorded against the attachment, e.g. `application/pdf`. */
  contentType: string;
  bytes: Uint8Array;
};

/**
 * The same 10 MB ceiling the portal upload path already applies.
 *
 * Deliberately the imported constant rather than a second copy of `10 * 1024 *
 * 1024`: a document CharityPilot accepted at upload must not then fail only at
 * the Confluence step, for a limit the user was never told about. If the portal
 * limit moves, this moves with it, and the test that pins them equal is what
 * keeps that true.
 */
export const CONFLUENCE_ATTACHMENT_MAX_BYTES = DOCUMENT_UPLOAD_MAX_FILE_SIZE;

/**
 * Ids are interpolated into a request path. Same pattern and same reasoning as
 * `confluence-pages.ts`: the core's path guard throws at **500**, which logs at
 * error level and fires the production alert webhook, and these ids arrive from
 * a request parameter or a database row. Validating here, and refusing as the
 * caller's error, is what stops somebody sending a malformed page id from
 * paging the on-call at will. The core's guard is a backstop, not the boundary.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Confluence's own cap on an attachment title. */
const MAX_FILENAME_LENGTH = 255;

/** v2's maximum page size for a collection. */
const LIST_PAGE_SIZE = 250;

/**
 * A ceiling on cursor following, so a misbehaving (or looping) upstream cannot
 * hold a caller open forever. 250 * 40 is 10,000 attachments on one page, which
 * is far past anything a governance page will hold.
 */
const MAX_LIST_PAGES = 40;

/** The form field name v1's upload endpoint expects. */
const FILE_FIELD = 'file';

function assertPageId(pageId: string): string {
  if (typeof pageId !== 'string' || !ID_PATTERN.test(pageId)) {
    // The value is not echoed: it is caller-supplied, and a diagnostic is not a
    // place to replay untrusted input into a log line.
    throw new AppError(
      400,
      'CONFLUENCE_PAGE_ID_INVALID',
      'A Confluence page id must be a plain identifier.',
    );
  }
  return pageId;
}

function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

/**
 * The filename never reaches the URL — it travels in the multipart body — so
 * this is not a traversal guard on a path. It is a guard on what becomes the
 * attachment's *title* in a charity's site: a `../` or a path separator in a
 * title is meaningless to a reader and suspicious to an auditor, and a control
 * character is the sort of thing that goes looking for a multipart header
 * parser somewhere between here and Atlassian.
 */
function assertFilename(filename: string): string {
  const invalid =
    typeof filename !== 'string' ||
    filename.length === 0 ||
    filename.length > MAX_FILENAME_LENGTH ||
    filename === '.' ||
    filename === '..' ||
    /[/\\]/.test(filename) ||
    hasControlCharacter(filename);

  if (invalid) {
    throw new AppError(
      400,
      'CONFLUENCE_ATTACHMENT_FILENAME_INVALID',
      `A Confluence attachment filename must be a plain file name of at most ${MAX_FILENAME_LENGTH} ` +
        'characters, with no path separators or control characters.',
    );
  }
  return filename;
}

function attachmentTooLarge(filename: string, size: number): AppError {
  const limitMb = Math.round(CONFLUENCE_ATTACHMENT_MAX_BYTES / (1024 * 1024));
  return new AppError(
    400,
    'CONFLUENCE_ATTACHMENT_TOO_LARGE',
    `The attachment "${filename}" is ${size} bytes, over the ${limitMb} MB limit CharityPilot ` +
      'applies to uploaded documents. It was not sent to Confluence.',
    { filename, bytes: size, limitBytes: CONFLUENCE_ATTACHMENT_MAX_BYTES },
  );
}

/**
 * Checked **before any request**, and before the body is even assembled.
 *
 * Atlassian answers an oversized attachment with a bare error that names
 * neither the file nor the limit, after the bytes have been sent — so the
 * charity waits for an upload that was never going to be accepted, and then
 * reads something it cannot act on.
 */
function assertUploadableSize(filename: string, payload: Uint8Array): Uint8Array {
  if (!(payload instanceof Uint8Array)) {
    throw new AppError(
      400,
      'CONFLUENCE_ATTACHMENT_INVALID',
      'A Confluence attachment must be supplied as bytes.',
      { filename },
    );
  }
  if (payload.byteLength === 0) {
    // Confluence rejects a zero-byte part, and a caller that reached here with
    // one has a bug worth naming rather than a network round trip worth making.
    throw new AppError(
      400,
      'CONFLUENCE_ATTACHMENT_EMPTY',
      `The attachment "${filename}" is empty, so it was not sent to Confluence.`,
      { filename },
    );
  }
  if (payload.byteLength > CONFLUENCE_ATTACHMENT_MAX_BYTES) {
    throw attachmentTooLarge(filename, payload.byteLength);
  }
  return payload;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** Confluence has returned ids as both strings and numbers across revisions. */
function readId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Joins a relative link onto the `_links.base` Confluence supplied, if any. */
function absolutise(link: string, base: string): string {
  if (link.length === 0) return '';
  if (/^https?:\/\//i.test(link)) return link;
  if (base.length === 0) return link;

  const trimmedBase = base.replace(/\/+$/, '');
  return link.startsWith('/') ? `${trimmedBase}${link}` : `${trimmedBase}/${link}`;
}

function readBase(body: unknown): string {
  const base = asObject(asObject(body)?._links)?.base;
  return typeof base === 'string' ? base : '';
}

function invalidResponse(what: string): AppError {
  return new AppError(
    502,
    'CONFLUENCE_RESPONSE_INVALID',
    `Confluence returned a response without a usable ${what}.`,
  );
}

/**
 * The same failure, told from the other side of an upload that already landed.
 *
 * By the time this parse runs the status line was 2xx, which means Confluence
 * did not merely see the request — it **committed** it, and the charity's file
 * is in the page. What was lost is only the attachment's identifier.
 *
 * `CONFLUENCE_RESPONSE_INVALID` would say "Confluence returned something
 * unusable", which a publish pipeline reads as "nothing happened" — and it
 * would upload the file again, adding a second version of a governance
 * document for no reason.
 *
 * The code is deliberately the core's own
 * `CONFLUENCE_WRITE_APPLIED_RESPONSE_UNREADABLE` rather than a third vocabulary
 * for the same situation, exactly as `confluence-pages.ts` chose. The core
 * raises it when a non-idempotent 2xx body cannot be *read*; this raises it
 * when the body read fine but was not an attachment. The instruction to the
 * caller is identical, and it is the instruction that matters.
 */
function writeAppliedIdentifierLost(what: string): AppError {
  return new AppError(
    502,
    'CONFLUENCE_WRITE_APPLIED_RESPONSE_UNREADABLE',
    `Confluence accepted an attachment upload but answered without a usable ${what}. ` +
      'The file WAS uploaded and only its identifier was lost. Do not reissue it: ' +
      "list the page's attachments, find the filename that was sent, and adopt it.",
  );
}

/**
 * One attachment, from either API version.
 *
 * v2 answers flat fields (`mediaType`, `fileSize`, `downloadLink`); v1 buries
 * the same facts under `extensions` and `_links.download`. Both are read here
 * so the caller never learns which endpoint produced the record.
 *
 * Strict on the id alone. Everything else is descriptive: an upload has already
 * landed by the time this runs, and failing the call over a missing media type
 * would hand the caller an error for a write that succeeded — which is the
 * precise situation that leads to a retry and a second version of the file.
 * The id is different: it is what a later audit record is keyed on, and a
 * record without one is not an attachment.
 */
function parseAttachment(
  record: unknown,
  base: string,
  unusable: (what: string) => AppError,
): ConfluenceAttachment {
  const attachment = asObject(record);
  if (attachment === undefined) throw unusable('attachment');

  const id = readId(attachment.id);
  if (id === undefined) throw unusable('attachment id');

  const extensions = asObject(attachment.extensions);
  const metadata = asObject(attachment.metadata);

  const mediaType =
    (typeof attachment.mediaType === 'string' ? attachment.mediaType : undefined) ??
    (typeof extensions?.mediaType === 'string' ? extensions.mediaType : undefined) ??
    (typeof metadata?.mediaType === 'string' ? metadata.mediaType : undefined) ??
    '';

  const fileSize =
    readNonNegativeNumber(attachment.fileSize) ?? readNonNegativeNumber(extensions?.fileSize) ?? 0;

  const downloadLink =
    (typeof attachment.downloadLink === 'string' ? attachment.downloadLink : undefined) ??
    (typeof asObject(attachment._links)?.download === 'string'
      ? (asObject(attachment._links)?.download as string)
      : undefined) ??
    '';

  return {
    id,
    title: typeof attachment.title === 'string' ? attachment.title : '',
    mediaType,
    fileSize,
    downloadUrl: absolutise(downloadLink, base),
  };
}

function readResults(body: unknown): unknown[] | undefined {
  const results = asObject(body)?.results;
  return Array.isArray(results) ? results : undefined;
}

/**
 * The cursor from `_links.next`, or `undefined` when this is the last page.
 *
 * Confluence sends `next` as a path with a query string. Only the `cursor`
 * parameter is taken from it: re-issuing the URL wholesale would let an
 * upstream response choose the path this client requests next, which is not a
 * decision a response body gets to make.
 */
function readNextCursor(body: unknown): string | undefined {
  const next = asObject(asObject(body)?._links)?.next;
  if (typeof next !== 'string' || next.length === 0) return undefined;

  try {
    // The base is a placeholder; only the query is read from the result.
    const cursor = new URL(next, 'https://confluence.invalid').searchParams.get('cursor');
    return cursor !== null && cursor.length > 0 ? cursor : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Listing — v2
// ---------------------------------------------------------------------------

/**
 * Every attachment on a page, following v2's cursor to the end of the list.
 *
 * Idempotent: reading changes nothing, so the core may retry it on a 429 or a
 * 5xx. The list is followed rather than truncated at the first page because a
 * caller asking "is this document already attached" gets the wrong answer from
 * a silently short list, and would then upload a second copy.
 */
export async function listAttachments(
  client: ConfluenceClient,
  pageId: string,
): Promise<ConfluenceAttachment[]> {
  const id = assertPageId(pageId);

  const attachments: ConfluenceAttachment[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const query: Record<string, string> = { limit: String(LIST_PAGE_SIZE) };
    if (cursor !== undefined) query.cursor = cursor;

    const response = await client.request({
      method: 'GET',
      api: 'v2',
      path: `pages/${id}/attachments`,
      query,
      idempotent: true,
    });

    const results = readResults(response.body);
    if (results === undefined) throw invalidResponse('attachment list');

    const base = readBase(response.body);
    for (const record of results) {
      attachments.push(parseAttachment(record, base, invalidResponse));
    }

    cursor = readNextCursor(response.body);
    if (cursor === undefined) return attachments;
  }

  throw new AppError(
    502,
    'CONFLUENCE_ATTACHMENT_LIST_UNBOUNDED',
    `Confluence kept offering another page of attachments after ${MAX_LIST_PAGES} requests. ` +
      'The list was not read to the end, so it is not safe to treat as complete.',
  );
}

// ---------------------------------------------------------------------------
// Upload — v1, because v2 has no upload endpoint
// ---------------------------------------------------------------------------

/**
 * A 403 on the v1 upload, which has one cause nothing else in this client has.
 *
 * The core maps 401 and 403 alike to `CONFLUENCE_RECONNECT_REQUIRED`, and for
 * almost every request that is the whole story: the stored grant is unusable
 * and the charity must reconnect. The upload is the exception, because it is
 * the only request that depends on `X-Atlassian-Token: nocheck` surviving the
 * trip. Anything between here and Atlassian that strips unknown headers — a
 * corporate proxy, a misconfigured egress gateway — produces a 403 that reads
 * as an expired grant, and a charity that reconnects will get the identical
 * 403 again, forever, with nothing anywhere saying why.
 *
 * The **code is kept** rather than replaced. A new code would not merely add a
 * fifth branch — it is one a Phase 4 handler written against the existing four
 * would *miss*, dropping a genuine expired grant into a generic failure path
 * and losing the reconnect prompt entirely. Reconnecting remains the action the
 * charity can take, so the code that means "reconnect" is the right one.
 *
 * The extra cause therefore goes in **`details`, not only the message**. A
 * message is the one part of an error a caller cannot branch on, and a
 * message-only mitigation leaves a charity behind a header-stripping proxy
 * being told to reconnect, reconnecting, and meeting the identical 403.
 * `possibleCsrfHeaderStripped` is something Phase 4 can act on — show the
 * operator-facing cause, or stop prompting for a reconnect that cannot help —
 * without any new vocabulary.
 *
 * 401 is left untouched. It is an expired or revoked token and has nothing to
 * do with CSRF; adding the hint there would send an operator hunting a proxy
 * that is working fine.
 */
function explainUploadForbidden(error: unknown): unknown {
  if (!(error instanceof AppError) || error.code !== 'CONFLUENCE_RECONNECT_REQUIRED') return error;

  const details = asObject(error.details);
  if (details?.status !== 403) return error;

  return new AppError(
    error.statusCode,
    error.code,
    `${error.message} A 403 on an attachment upload has one other likely cause: the required ` +
      'X-Atlassian-Token: nocheck header did not reach Atlassian, which then refuses the upload ' +
      'as a suspected CSRF attempt. Check for a proxy stripping it before assuming the grant is stale.',
    { ...details, possibleCsrfHeaderStripped: true },
  );
}

/**
 * Uploads a file as an attachment on a page, through **v1** — see the header
 * for why, and do not move it.
 *
 * **Not idempotent.** Repeating an upload of the same filename to the same page
 * creates a new *version* of that attachment rather than a duplicate, which is
 * milder than the duplicate-page hazard but is still an unintended change to a
 * charity's record. A caller that receives `CONFLUENCE_REQUEST_INDETERMINATE`
 * or `CONFLUENCE_RATE_LIMITED_UNSAFE_RETRY` reconciles with `listAttachments`
 * rather than calling this again blindly.
 *
 * Every argument is validated before a single byte is sent: the page id
 * (because a malformed one would reach the core's 500 and page the on-call),
 * the filename, and the size against the portal's own 10 MB ceiling.
 */
export async function uploadAttachment(
  client: ConfluenceClient,
  input: UploadAttachmentInput,
): Promise<ConfluenceAttachment> {
  const id = assertPageId(input.pageId);
  const filename = assertFilename(input.filename);
  const payload = assertUploadableSize(filename, input.bytes);

  const formData = new FormData();
  // `Blob` and `FormData` are built in; no dependency is needed to build a
  // multipart body, and the boundary is fetch's to generate — which is why no
  // Content-Type is set here, and why the core refuses one alongside a body.
  formData.append(FILE_FIELD, new Blob([payload], { type: input.contentType }), filename);

  let response;
  try {
    response = await client.request({
      method: 'POST',
      api: 'v1',
      path: `content/${id}/child/attachment`,
      formData,
      // Required. Without it Atlassian refuses the request as a suspected CSRF
      // attempt. This is not optional and is not a legacy relic.
      headers: { 'X-Atlassian-Token': 'nocheck' },
      // An upload cannot be repeated safely. This is the single most important
      // line in the module.
      idempotent: false,
    });
  } catch (error) {
    throw explainUploadForbidden(error);
  }

  // Past this line the upload has landed: a parse failure is a lost identifier,
  // not a request that did nothing.
  const results = readResults(response.body);
  const record = results?.[0];
  if (record === undefined) throw writeAppliedIdentifierLost('attachment');

  return parseAttachment(record, readBase(response.body), writeAppliedIdentifierLost);
}
