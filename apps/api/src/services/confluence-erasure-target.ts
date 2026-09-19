import { AppError } from '../utils/errors.js';

/**
 * The shape a deletion row's `targetRef` must hold for a Confluence-backed
 * document. `targetRef` is an unconstrained `Json?` column — the database will
 * not check it and neither will TypeScript once it round-trips through
 * Prisma — so this module is the only boundary standing between whatever a
 * caller wrote into that column and an eraser that will act on it.
 *
 * Phase 4's publish pipeline is blocked and cannot yet say what it will
 * write, so this type is written first and Phase 4 must conform to it: the
 * shape flows from erasure to publish, not the other way around. Letting the
 * publish pipeline define the record and having erasure chase it afterwards
 * is exactly how unerasable data gets created.
 *
 * `cloudId` travels on the row rather than being re-resolved from the
 * organisation's live Confluence connection, because a charity may
 * disconnect and reconnect to a *different* site and still be owed erasure
 * from the first. The row must remember where the bytes actually went, not
 * where the connection currently points.
 */
export type ConfluenceErasureTarget = {
  kind: 'confluence';
  cloudId: string;
  pageId: string;
  attachmentIds: string[];
};

/**
 * A malformed target is permanent, not transient — retrying does not repair a
 * record the publish pipeline wrote incorrectly. Every refusal in this module
 * therefore raises the same 500 code, which Task 5's caller maps to an
 * immediate dead-letter rather than the ordinary claim/backoff retry loop.
 */
function malformed(reason: string): AppError {
  return new AppError(
    500,
    'ERASURE_TARGET_MALFORMED',
    `A Confluence erasure target is malformed: ${reason}. This will not improve on retry.`,
    { reason },
  );
}

/** Plain objects only — `null` and arrays are excluded so callers cannot pass either and have `typeof` say "object". */
function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A non-empty string. Both `cloudId` and `pageId` address something: a
 * present-but-empty value parses without error yet names nothing, and an
 * eraser that trusted it would issue a delete against a path naming nothing
 * and report success. Treated as malformed, the same as an absent field.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validates and normalises `value` into a {@link ConfluenceErasureTarget}, or
 * throws `AppError(500, 'ERASURE_TARGET_MALFORMED', …)`.
 *
 * The returned `attachmentIds` array is always a fresh copy, never the
 * caller's own array: Task 5's eraser iterates it while issuing deletes, and
 * handing back an alias would let later code mutate what this row was
 * validated as naming.
 */
export function parseConfluenceErasureTarget(value: unknown): ConfluenceErasureTarget {
  const target = asPlainObject(value);
  if (target === undefined) throw malformed('the target is not a plain object');

  if (target.kind !== 'confluence') throw malformed('kind is not "confluence"');

  if (!isNonEmptyString(target.cloudId)) {
    throw malformed('cloudId is missing, not a string, or empty');
  }

  if (!isNonEmptyString(target.pageId)) {
    throw malformed('pageId is missing, not a string, or empty');
  }

  if (!Array.isArray(target.attachmentIds)) {
    throw malformed('attachmentIds is not an array');
  }

  // A fresh array, built element by element: it neither aliases the caller's
  // array (see the doc comment above) nor accepts a non-string element by
  // passing it through uninspected.
  const attachmentIds: string[] = [];
  for (const [index, id] of target.attachmentIds.entries()) {
    if (typeof id !== 'string') throw malformed(`attachmentIds[${index}] is not a string`);
    attachmentIds.push(id);
  }

  return {
    kind: 'confluence',
    cloudId: target.cloudId,
    pageId: target.pageId,
    attachmentIds,
  };
}
