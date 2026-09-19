import { AppError } from '../utils/errors.js';
import type { ConfluenceClient } from './confluence-client.js';

/**
 * `GET /wiki/api/v2/spaces` — the list a charity picks a publish destination
 * from. Built on the HTTP core in `confluence-client.ts`, in the same spirit
 * as `confluence-pages.ts` and `confluence-attachments.ts`: this module
 * decides *what* is asked of Confluence, and nothing here decides whether a
 * request may be repeated.
 *
 * ## Idempotent, unlike the create path this feeds
 *
 * A read changes nothing, so unlike `createPage` this is issued
 * `idempotent: true` and the core may retry it on a 429 or a 5xx without
 * risking the duplicate-write hazard the rest of this client exists to avoid.
 *
 * ## Only three fields cross the tenant boundary
 *
 * A Confluence space object carries far more than this — a description, a
 * homepage id, permission hints — and this response is read by a browser, not
 * by another server-side module. `ConfluenceSpace` is deliberately narrow, and
 * `parseSpace` builds one field at a time rather than spreading the upstream
 * record: the `status` route in `routes/integrations/index.ts` polices the
 * same boundary with a keys allow-list and a substring check forbidding
 * `refresh`/`token`/`secret`, and this module is the other place that promise
 * has to hold. Widening `ConfluenceSpace` is a decision for a human, not a
 * side effect of a careless `...record`.
 *
 * ## The cursor walk, and why exceeding its bound is not an error here
 *
 * `_links.next` is followed exactly as `confluence-attachments.ts` follows
 * it — same query shape, same reasoning: an unbounded walk against a large
 * site is a way to hang a request thread, so it is capped. Where this module
 * differs is what happens at the cap. `listAttachments` must throw, because a
 * caller asking "is this file already attached" gets a wrong answer from a
 * silently short list. A space picker has no such correctness obligation: a
 * charity choosing where to publish is well served by *some* spaces plus a
 * way to see more, and is not well served by an error page. So this walk
 * returns what it has read, plus `nextCursor` to resume from, rather than
 * discarding a partial answer as a failure.
 */

/** The shape callers get back. Deliberately narrow — see the module header. */
export type ConfluenceSpace = {
  id: string;
  key: string;
  name: string;
};

export type ListSpacesResult = {
  spaces: ConfluenceSpace[];
  /** Present only when more spaces remain unread; pass it back in to continue. */
  nextCursor?: string;
};

/** v2's maximum page size for a collection — the same value `confluence-attachments.ts` uses, for the same reason. */
const LIST_PAGE_SIZE = 250;

/**
 * The same bound `confluence-attachments.ts` applies to its own cursor walk,
 * and for the identical reason: this is what stops a misbehaving (or looping)
 * upstream from holding a caller open forever. 250 * 40 is 10,000 spaces,
 * which is far past anything a real charity's site will hold — and unlike
 * that module, reaching it here is not fatal; see the module header.
 */
const MAX_LIST_PAGES = 40;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** v2 has returned ids as both strings and numbers across revisions. */
function readId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function readResults(body: unknown): unknown[] | undefined {
  const results = asObject(body)?.results;
  return Array.isArray(results) ? results : undefined;
}

/**
 * The cursor from `_links.next`, or `undefined` when this is the last page.
 *
 * Identical in shape and reasoning to `confluence-attachments.ts`'s version:
 * only the `cursor` query parameter is taken from the link Confluence sent,
 * never the path wholesale — a response body does not get to choose what this
 * client requests next.
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

function invalidResponse(what: string): AppError {
  return new AppError(
    502,
    'CONFLUENCE_RESPONSE_INVALID',
    `Confluence returned a response without a usable ${what}.`,
  );
}

/**
 * One space record. Strict on `id` and `key` — both are what a later publish
 * choice is keyed on — and lenient on `name`, which is display text only and
 * whose absence should not turn a listable space into a parse failure.
 *
 * Built field by field. Never `{ ...record }`: see the module header on why a
 * space object's other fields must not cross this boundary.
 */
function parseSpace(record: unknown): ConfluenceSpace {
  const space = asObject(record);
  if (space === undefined) throw invalidResponse('space');

  const id = readId(space.id);
  if (id === undefined) throw invalidResponse('space id');

  const key = typeof space.key === 'string' && space.key.length > 0 ? space.key : undefined;
  if (key === undefined) throw invalidResponse('space key');

  return {
    id,
    key,
    name: typeof space.name === 'string' ? space.name : '',
  };
}

/**
 * One page of the spaces a charity's connected site holds, following a
 * caller-supplied cursor if given.
 *
 * **Idempotent**: a read changes nothing, so the core may retry it on a 429 or
 * a 5xx.
 *
 * Walks `_links.next` internally, bounded by {@link MAX_LIST_PAGES} — see the
 * module header for why exceeding that bound returns a partial list plus
 * `nextCursor` rather than throwing. In the ordinary case a charity's whole
 * space list fits in a single upstream page (`limit=250`), so the walk runs
 * once and `nextCursor` is `undefined`.
 */
export async function listSpaces(client: ConfluenceClient, cursor?: string): Promise<ListSpacesResult> {
  const spaces: ConfluenceSpace[] = [];
  let next = cursor;

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const query: Record<string, string> = { limit: String(LIST_PAGE_SIZE) };
    if (next !== undefined) query.cursor = next;

    const response = await client.request({
      method: 'GET',
      api: 'v2',
      path: 'spaces',
      query,
      idempotent: true,
    });

    const results = readResults(response.body);
    if (results === undefined) throw invalidResponse('space list');

    for (const record of results) {
      spaces.push(parseSpace(record));
    }

    next = readNextCursor(response.body);
    if (next === undefined) return { spaces };
  }

  // The bound was reached with more still unread. Handed back rather than
  // discarded: see the module header.
  return { spaces, nextCursor: next };
}
