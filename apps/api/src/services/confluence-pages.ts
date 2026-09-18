import { AppError } from '../utils/errors.js';
import type { ConfluenceClient } from './confluence-client.js';

/**
 * Page and content-property operations, built on the HTTP core in
 * `confluence-client.ts`. This module decides *what* is asked of Confluence;
 * the core decides how a request is carried and whether it may be repeated.
 *
 * ## The one thing to get right
 *
 * Every request declares `idempotent`, and the core's retry policy keys on it:
 * it retries idempotent requests on 429 and 5xx and refuses to retry anything
 * else. The flag is an assertion about *this* request, not a property of the
 * HTTP method.
 *
 * - `POST /pages` is **not** idempotent. A 429, a timeout or a dropped
 *   connection after Confluence has committed the write turns a retry into two
 *   identical governance documents in a charity's space. For a product whose
 *   purpose is an auditable record, a silent duplicate is worse than a failed
 *   publish, so a create that may or may not have applied is surfaced as such
 *   (`CONFLUENCE_REQUEST_INDETERMINATE`) and reconciled by the caller.
 * - `GET /pages/{id}` is idempotent. Reading twice changes nothing.
 * - `PUT /pages/{id}` is idempotent **because it carries the version it
 *   expects**, and for no other reason. Confluence accepts the update only
 *   when the version number sent is the successor of the page's current one,
 *   so a repeat of an applied update fails the version check instead of
 *   applying twice. A future edit that drops the version from the body would
 *   leave the flag true and silently make the request unsafe: the flag and the
 *   version travel together or not at all.
 *
 * The same reasoning governs content properties: creating one is a POST and is
 * not safe to repeat; updating one carries the property's own version and is.
 */

/** The shape callers get back. Deliberately small: nothing here carries a body. */
export type ConfluencePage = {
  id: string;
  title: string;
  spaceId: string;
  version: number;
  /** Absolute when Confluence supplied a base, otherwise whatever it gave; `''` when it gave nothing. */
  webUrl: string;
};

export type ConfluenceContentProperty = {
  id: string;
  key: string;
  value: unknown;
  version: number;
};

export type CreatePageInput = {
  spaceId: string;
  title: string;
  /** Confluence storage-format XHTML. */
  bodyStorage: string;
  parentId?: string;
};

export type UpdatePageInput = {
  pageId: string;
  title: string;
  bodyStorage: string;
  /**
   * The version number the caller last read. The request sends its successor,
   * which is what Confluence requires and what makes the update safe to repeat.
   */
  expectedVersion: number;
};

/**
 * Confluence caps a content property's JSON value at 32 KB. Governance metadata
 * — the approving resolution, the approval date, the next review date, the
 * linked standard — lives here, and a caller that exceeds this gets a bare 400
 * from Atlassian that does not say *which* property was too large. So the size
 * is checked here, before anything is sent, and the error names the key.
 */
export const CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES = 32 * 1024;

/**
 * Ids and keys are interpolated into a request path. The core rejects
 * traversal, but only after this module has already built a path out of a
 * value it did not check — and `pages/123/attachments` would pass the core's
 * check while addressing something the caller never asked for. Validate at the
 * point the value becomes part of a path, and reject rather than sanitise.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Confluence content-property keys allow letters, digits, `.`, `-` and `_`. */
const PROPERTY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

const STORAGE_REPRESENTATION = 'storage';

/** The only page status this module writes. Drafts are Phase 4's business, if ever. */
const CURRENT = 'current';

/**
 * A rejected identifier, and the reason it is a 4xx rather than a 500.
 *
 * The HTTP core's own path guard throws `CONFLUENCE_REQUEST_PATH_INVALID` at
 * 500, which is right for it: a malformed path that reaches the core is a
 * programming error. But 500 in this codebase logs at error level and fires
 * the production alert webhook, and the ids these functions take will arrive
 * from a request parameter or a database row. If an unvalidated id could reach
 * `spec.path`, a caller sending a malformed one could page the on-call at
 * will. So the shape is checked *here*, at this module's boundary, and refused
 * as the caller's error. The core's guard is a backstop, not the boundary.
 */
function invalidId(code: string, what: string): AppError {
  // The value is not echoed: it is caller-supplied and a diagnostic is not a
  // place to replay untrusted input into a log line.
  return new AppError(400, code, `A Confluence ${what} must be a plain identifier.`);
}

function assertPageId(pageId: string): string {
  if (typeof pageId !== 'string' || !ID_PATTERN.test(pageId)) {
    throw invalidId('CONFLUENCE_PAGE_ID_INVALID', 'page id');
  }
  return pageId;
}

function assertPropertyId(propertyId: string): string {
  if (typeof propertyId !== 'string' || !ID_PATTERN.test(propertyId)) {
    throw invalidId('CONFLUENCE_PROPERTY_ID_INVALID', 'content property id');
  }
  return propertyId;
}

function assertPropertyKey(key: string): string {
  if (typeof key !== 'string' || !PROPERTY_KEY_PATTERN.test(key)) {
    throw invalidId('CONFLUENCE_PROPERTY_KEY_INVALID', 'content property key');
  }
  return key;
}

/** 4xx for the same reason as `invalidId`: a version can arrive from a request. */
function assertVersion(version: number, code: string): number {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AppError(
      400,
      code,
      'A Confluence version must be a positive whole number obtained by reading the resource first.',
    );
  }
  return version;
}

function invalidResponse(what: string): AppError {
  return new AppError(
    502,
    'CONFLUENCE_RESPONSE_INVALID',
    `Confluence returned a response without a usable ${what}.`,
  );
}

/**
 * The same error, told from the other side of a write that already landed.
 *
 * A create answers 2xx and then fails to parse: the page **exists**, and all
 * that was lost is the identifier. `CONFLUENCE_RESPONSE_INVALID` would say
 * "Confluence returned something unusable", which a publish pipeline reads as
 * "nothing happened" — and it would create the page again. That is the
 * duplicate this whole phase exists to prevent, arriving through a door the
 * retry policy does not watch.
 *
 * This is the `webUrl` argument applied one field over: the fix is not to relax
 * the parse, which would persist a page with no id, but to label the failure
 * truthfully.
 *
 * The code is deliberately the core's own `CONFLUENCE_WRITE_APPLIED_RESPONSE_UNREADABLE`
 * rather than a third vocabulary for the same situation. The core raises it
 * when a non-idempotent 2xx body cannot be *read*; this raises it when the body
 * read fine but was not a page. The instruction to the caller is identical, and
 * it is the instruction that matters: do not reissue, search and adopt.
 */
function writeAppliedIdentifierLost(what: string): AppError {
  return new AppError(
    502,
    'CONFLUENCE_WRITE_APPLIED_RESPONSE_UNREADABLE',
    `Confluence accepted a page create but answered without a usable ${what}. ` +
      'The page WAS created and only its identifier was lost. Do not reissue it: ' +
      'search the space for the title that was sent and adopt the page.',
  );
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** v2 has returned ids as both strings and numbers across revisions. */
function readId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Joins `_links.webui` onto `_links.base` when both are present.
 *
 * Returns `''` rather than throwing when Confluence gave no link. This is the
 * one field parsed leniently, and deliberately: by the time a create response
 * is parsed the page **already exists**, so failing the call over a cosmetic
 * link would hand the caller an error for a write that succeeded — which is
 * precisely the situation that leads to a retry and a duplicate page.
 */
function readWebUrl(links: Record<string, unknown> | undefined): string {
  const webui = typeof links?.webui === 'string' ? links.webui : '';
  if (webui.length === 0) return '';
  if (/^https?:\/\//i.test(webui)) return webui;

  const base = typeof links?.base === 'string' ? links.base : '';
  if (base.length === 0) return webui;

  const trimmedBase = base.replace(/\/+$/, '');
  return webui.startsWith('/') ? `${trimmedBase}${webui}` : `${trimmedBase}/${webui}`;
}

/**
 * Strict on everything the caller cannot proceed without — the id and the
 * version are what a later publish, update or audit record is keyed on, and a
 * page object missing either is not one.
 *
 * `writeApplied` says whether a write has already landed by the time the parse
 * runs, and it changes only the *label* on the failure, never the strictness.
 * It mirrors `idempotent` on the request: the caller states the fact, because
 * the caller is the only one that knows it.
 */
function parsePage(body: unknown, writeApplied = false): ConfluencePage {
  const unusable = (what: string): AppError =>
    writeApplied ? writeAppliedIdentifierLost(what) : invalidResponse(what);

  const page = asObject(body);
  if (page === undefined) throw unusable('page');

  const id = readId(page.id);
  if (id === undefined) throw unusable('page id');

  const spaceId = readId(page.spaceId);
  if (spaceId === undefined) throw unusable('space id');

  const versionNumber = asObject(page.version)?.number;
  if (typeof versionNumber !== 'number' || !Number.isFinite(versionNumber)) {
    throw unusable('page version');
  }

  return {
    id,
    title: typeof page.title === 'string' ? page.title : '',
    spaceId,
    version: versionNumber,
    webUrl: readWebUrl(asObject(page._links)),
  };
}

function isUpstream(error: unknown, code: string): boolean {
  return error instanceof AppError && error.code === code;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * Creates a page. **Not idempotent**: see the header. A caller that receives
 * `CONFLUENCE_REQUEST_INDETERMINATE` or `CONFLUENCE_RATE_LIMITED_UNSAFE_RETRY`
 * must reconcile by searching for the page rather than calling this again
 * blindly.
 *
 * A 409 here is deliberately **not** translated into a version conflict. The
 * core maps every 409 to `CONFLUENCE_CONFLICT`, but a 409 on a create is not a
 * version conflict — Confluence also uses it for a duplicate title in a space.
 * Relabelling it would tell a caller "someone else edited this page, re-read
 * and retry", and a caller that obeyed would re-read, find nothing in
 * conflict, and try again forever. Only the update paths translate it.
 */
export async function createPage(
  client: ConfluenceClient,
  input: CreatePageInput,
): Promise<ConfluencePage> {
  const body: Record<string, unknown> = {
    spaceId: input.spaceId,
    status: CURRENT,
    title: input.title,
    body: { representation: STORAGE_REPRESENTATION, value: input.bodyStorage },
  };
  if (input.parentId !== undefined) body.parentId = assertPageId(input.parentId);

  const response = await client.request({
    method: 'POST',
    api: 'v2',
    path: 'pages',
    body,
    // Creating a page cannot be repeated safely. This is the single most
    // important line in the module.
    idempotent: false,
  });

  // The write has landed. A parse failure past this line is a lost identifier,
  // not a request that did nothing.
  return parsePage(response.body, true);
}

/**
 * Reads a page, or `null` when it does not exist.
 *
 * A 404 is not an error here: "does this page still exist" is a question the
 * publish pipeline asks routinely, and `null` is the answer. Every other
 * failure — an expired grant, a rate limit, Atlassian being down — propagates
 * untouched, because none of them mean "absent".
 */
export async function getPage(
  client: ConfluenceClient,
  pageId: string,
): Promise<ConfluencePage | null> {
  const id = assertPageId(pageId);

  let response;
  try {
    response = await client.request({
      method: 'GET',
      api: 'v2',
      path: `pages/${id}`,
      // A read changes nothing, so the core may retry it on a 429 or a 5xx.
      idempotent: true,
    });
  } catch (error) {
    if (isUpstream(error, 'CONFLUENCE_NOT_FOUND')) return null;
    throw error;
  }

  return parsePage(response.body);
}

/**
 * A refused update, expressed as what is actually known about it — which is
 * less than this error used to claim.
 *
 * It said "somebody else changed it first" and "your version was not applied
 * by this call". Neither is knowable here.
 *
 * **The cause is not knowable.** Confluence answers 409 both for a stale
 * version and for a title already held by another page in the space — the
 * second is exactly why `createPage` leaves its own 409 untranslated — and
 * `updatePage` sends a `title` as well as a version. The HTTP core surfaces no
 * response body, so this module receives nothing that separates the two. A
 * caller told "somebody edited this, re-read and retry" for what is really a
 * rename collision re-reads, finds the version unchanged, and reapplies
 * forever: the loop the `createPage` reasoning exists to prevent, arriving
 * through the update path instead.
 *
 * **Non-application is not knowable either.** `updatePage` is `idempotent`, so
 * the core retries it on a 5xx. If the first attempt committed and the gateway
 * then answered 502, the retry sends the same version, meets a genuine 409, and
 * the change *has* been applied — by this call. Recovery is unaffected (the
 * caller re-reads and finds its own change), but the statement would be false,
 * and a pipeline can branch on a statement.
 *
 * The version Confluence actually holds is still **not** reported, for the
 * original reason: it never reaches this module, and naming a number that was
 * never received would have a caller key its recovery on a guess. The re-read
 * is what resolves all of it — the page's version and its title together say
 * which of the two happened, and whether the change is already there.
 *
 * The code stays `CONFLUENCE_PAGE_VERSION_CONFLICT`: it is the documented name
 * for "an update was refused under the version you supplied", and renaming it
 * would break callers to say the same thing.
 */
function pageVersionConflict(pageId: string, expectedVersion: number): AppError {
  return new AppError(
    409,
    'CONFLUENCE_PAGE_VERSION_CONFLICT',
    `Confluence refused an update to page ${pageId} sent against version ${expectedVersion}. ` +
      'It answers 409 both when the page has moved past that version and when the title sent is ' +
      'already held by another page in the space, and it surfaces no response body to this client, ' +
      'so which of the two it was is not known here. Nor is it known that the change did not land: ' +
      'this call is retried on a 5xx, so an earlier attempt of it may already have been committed. ' +
      'Re-read the page — its version and its title together say what happened — then decide ' +
      'whether to reapply the change.',
    { pageId, expectedVersion },
  );
}

/**
 * Updates a page in place.
 *
 * **Idempotent, and only because of the version.** `expectedVersion` is the
 * number the caller read; the request sends its successor, which Confluence
 * accepts only while the page is still at `expectedVersion`. A repeat of an
 * applied update therefore fails the version check rather than applying twice,
 * which is exactly what makes it safe for the core to retry. Remove the
 * version and the `idempotent: true` below becomes a lie.
 */
export async function updatePage(
  client: ConfluenceClient,
  input: UpdatePageInput,
): Promise<ConfluencePage> {
  const id = assertPageId(input.pageId);
  const expectedVersion = assertVersion(input.expectedVersion, 'CONFLUENCE_PAGE_VERSION_INVALID');

  let response;
  try {
    response = await client.request({
      method: 'PUT',
      api: 'v2',
      path: `pages/${id}`,
      body: {
        id,
        status: CURRENT,
        title: input.title,
        body: { representation: STORAGE_REPRESENTATION, value: input.bodyStorage },
        version: { number: expectedVersion + 1 },
      },
      idempotent: true,
    });
  } catch (error) {
    // A refusal to act on rather than a fault to bury. A charity's DPO editing
    // a policy while a publish runs lands here, and so does a rename onto a
    // title the space already holds. The error says both, because nothing that
    // reaches this module tells them apart.
    if (isUpstream(error, 'CONFLUENCE_CONFLICT')) throw pageVersionConflict(id, expectedVersion);
    throw error;
  }

  return parsePage(response.body);
}

// ---------------------------------------------------------------------------
// Content properties
// ---------------------------------------------------------------------------

function contentPropertyTooLarge(key: string, bytes: number): AppError {
  // The value is never included: it is governance metadata that may name
  // people, and an error that quotes it would carry it into a log.
  return new AppError(
    400,
    'CONFLUENCE_CONTENT_PROPERTY_TOO_LARGE',
    `The Confluence content property "${key}" serialises to ${bytes} bytes, over the ` +
      `${CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES}-byte limit Confluence enforces. It was not sent. ` +
      'Store less in the property, or put the bulk on the page itself.',
    { key, bytes, limitBytes: CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES },
  );
}

/**
 * Serialises the value and checks its size *before any request is made*.
 *
 * Confluence answers an oversized property with a bare 400 that does not say
 * which property was at fault. Catching it here gives the caller a key and a
 * byte count, which is something it can act on.
 */
function serialiseContentProperty(key: string, value: unknown): string {
  let serialised: string | undefined;
  try {
    serialised = JSON.stringify(value);
  } catch {
    serialised = undefined;
  }

  if (typeof serialised !== 'string') {
    throw new AppError(
      400,
      'CONFLUENCE_CONTENT_PROPERTY_INVALID',
      `The Confluence content property "${key}" could not be serialised to JSON.`,
      { key },
    );
  }

  // Bytes, not characters: the limit is on the payload, and one accented
  // character in a charity's name is two bytes.
  const bytes = Buffer.byteLength(serialised, 'utf8');
  if (bytes > CONFLUENCE_CONTENT_PROPERTY_MAX_BYTES) throw contentPropertyTooLarge(key, bytes);

  return serialised;
}

function parseContentProperty(body: unknown, expectedKey: string): ConfluenceContentProperty | null {
  const results = asObject(body)?.results;
  if (!Array.isArray(results) || results.length === 0) return null;

  const record = asObject(results[0]);
  if (record === undefined) throw invalidResponse('content property');

  const id = readId(record.id);
  if (id === undefined) throw invalidResponse('content property id');

  // The `?key=` filter is load-bearing: this id is what `setContentProperty`
  // then PUTs to. If Confluence ever answered with a property that is not the
  // one asked for, taking `results[0]` on trust would overwrite an unrelated
  // property. One comparison closes that, and it is cheap.
  if (record.key !== expectedKey) throw invalidResponse('content property for the requested key');

  const versionNumber = asObject(record.version)?.number;
  if (typeof versionNumber !== 'number' || !Number.isFinite(versionNumber)) {
    throw invalidResponse('content property version');
  }

  return {
    id,
    key: expectedKey,
    value: record.value,
    version: versionNumber,
  };
}

/**
 * Reads a content property whole, including its id and version — which is what
 * a caller needs in order to pass `expectedVersion` to `setContentProperty`.
 *
 * `null` means **the property is not set on a page that exists**, and nothing
 * else. A missing *page* is not the same answer and is not flattened into it:
 * Confluence answers an unset property on a live page with an empty result
 * list and a missing page with a 404, and the 404 propagates as
 * `CONFLUENCE_NOT_FOUND`. A publish pipeline told `null` for a deleted page
 * would conclude the metadata simply needs writing, try to write it, and fail
 * at the far end with something much harder to read.
 */
export async function getContentPropertyRecord(
  client: ConfluenceClient,
  pageId: string,
  key: string,
): Promise<ConfluenceContentProperty | null> {
  const id = assertPageId(pageId);
  const propertyKey = assertPropertyKey(key);

  const response = await client.request({
    method: 'GET',
    api: 'v2',
    path: `pages/${id}/properties`,
    query: { key: propertyKey },
    idempotent: true,
  });

  return parseContentProperty(response.body, propertyKey);
}

/** The property's value alone, or `null` when it is not set on an existing page. */
export async function getContentProperty(
  client: ConfluenceClient,
  pageId: string,
  key: string,
): Promise<unknown> {
  const record = await getContentPropertyRecord(client, pageId, key);
  return record === null ? null : record.value;
}

/**
 * A content-property version conflict.
 *
 * `foundVersion` is passed only when it is a version this module actually
 * read — the lookup it issued a moment ago. When Confluence itself rejects the
 * write, the version it holds is in a response body the core does not surface,
 * so the field is omitted rather than filled with the stale number from the
 * lookup. Same rule as `pageVersionConflict`: never report a version that was
 * not received.
 */
function contentPropertyVersionConflict(
  pageId: string,
  key: string,
  expectedVersion: number,
  foundVersion?: number,
): AppError {
  const found =
    foundVersion === undefined
      ? 'is no longer at the version that was read'
      : `is at version ${foundVersion}, not the expected ${expectedVersion}`;

  return new AppError(
    409,
    'CONFLUENCE_CONTENT_PROPERTY_VERSION_CONFLICT',
    `The Confluence content property "${key}" on page ${pageId} ${found}, so somebody else ` +
      'changed it first. Your value was not applied by this call. Re-read the property and ' +
      'decide whether to reapply the change.',
    foundVersion === undefined
      ? { pageId, key, expectedVersion }
      : { pageId, key, expectedVersion, foundVersion },
  );
}

/**
 * Writes a content property, creating it if it does not exist.
 *
 * The size check runs first, before the lookup, so an oversized value costs no
 * request at all.
 *
 * `expectedVersion` is the **property's** version, not the page's, and is
 * optional: supply it to assert that nothing has changed the property since it
 * was read, and a mismatch is refused without writing. Whether it is supplied
 * or not the write itself is still version-pinned, so a concurrent writer that
 * slips in between the read and the write is caught by Confluence.
 */
export async function setContentProperty(
  client: ConfluenceClient,
  pageId: string,
  key: string,
  value: unknown,
  expectedVersion?: number,
): Promise<void> {
  const id = assertPageId(pageId);
  const propertyKey = assertPropertyKey(key);
  if (expectedVersion !== undefined) {
    assertVersion(expectedVersion, 'CONFLUENCE_CONTENT_PROPERTY_VERSION_INVALID');
  }

  // Before the lookup: an oversized property must cost nothing.
  serialiseContentProperty(propertyKey, value);

  const existing = await getContentPropertyRecord(client, id, propertyKey);

  if (existing === null) {
    if (expectedVersion !== undefined) {
      throw new AppError(
        409,
        'CONFLUENCE_CONTENT_PROPERTY_VERSION_CONFLICT',
        `The Confluence content property "${propertyKey}" on page ${id} no longer exists, so the ` +
          `expected version ${expectedVersion} cannot hold. Nothing was written. Re-read the ` +
          'property and decide whether to reapply the change.',
        { pageId: id, key: propertyKey, expectedVersion },
      );
    }

    await client.request({
      method: 'POST',
      api: 'v2',
      path: `pages/${id}/properties`,
      body: { key: propertyKey, value },
      // Creating a property is a create. Repeating it is Confluence's to
      // reject, not ours to gamble on.
      idempotent: false,
    });
    return;
  }

  if (expectedVersion !== undefined && existing.version !== expectedVersion) {
    throw contentPropertyVersionConflict(id, propertyKey, expectedVersion, existing.version);
  }

  try {
    await client.request({
      method: 'PUT',
      api: 'v2',
      path: `pages/${id}/properties/${assertPropertyId(existing.id)}`,
      body: {
        key: propertyKey,
        value,
        version: { number: existing.version + 1 },
      },
      // Safe to repeat for the same reason `updatePage` is: the version in the
      // body means a second application cannot take.
      idempotent: true,
    });
  } catch (error) {
    if (isUpstream(error, 'CONFLUENCE_CONFLICT')) {
      // No found version: the number in `existing` is the one Confluence has
      // just told us is stale.
      throw contentPropertyVersionConflict(id, propertyKey, expectedVersion ?? existing.version);
    }
    throw error;
  }
}
