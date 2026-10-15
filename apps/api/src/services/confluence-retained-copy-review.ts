import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../utils/app-error.js';

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const evidence = z.string().min(3).max(120).regex(/^[A-Z0-9][A-Z0-9-]+$/);
const timestamp = z.string().datetime({ precision: 3 });
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const unique = <T>(items: T[]) => new Set(items).size === items.length;
const attachment = z.object({
  id: identifier,
  currentVersion: version,
  versions: z.array(z.object({
    number: version, sha256: hash,
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict()).min(1).max(1000),
}).strict().refine((a) => unique(a.versions.map((v) => v.number))
  && a.versions.some((v) => v.number === a.currentVersion)
  && a.versions.every((v) => v.number <= a.currentVersion), 'Invalid attachment versions');

const snapshotSchema = z.object({
  organisationId: identifier, documentId: identifier, sourceRevision: timestamp,
  sourceSha256: hash, lifecycleStatus: z.literal('RETIRED'),
  deletionHold: z.literal(false), externalPublicationApproved: z.literal(false),
  publicationId: identifier, publicationRevision: timestamp, publicationState: z.literal('RETIRED'),
  cloudId: z.string().uuid(),
  siteOrigin: z.string().max(100).regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/),
  spaceId: identifier, pageId: identifier,
  inventory: z.object({
    observedAt: timestamp, status: z.literal('CURRENT'), complete: z.literal(true),
    currentPageVersion: version, pageVersions: z.array(version).min(1).max(1000),
    attachments: z.array(attachment).max(100),
  }).strict().refine((i) => unique(i.pageVersions)
    && i.pageVersions.includes(i.currentPageVersion)
    && i.pageVersions.every((v) => v <= i.currentPageVersion)
    && unique(i.attachments.map((a) => a.id)), 'Invalid inventory'),
}).strict();

const reviewSchema = z.object({
  scope: z.literal('SYNTHETIC_ONLY'), primaryDisposition: z.literal('RETAIN'),
  copyDisposition: z.literal('PURGE'), reviewerId: identifier,
  evidenceRef: evidence, retentionDecisionRef: evidence, holdReviewRef: evidence,
  inventoryEvidenceRef: evidence, syntheticEvidenceRef: evidence,
  reviewedAt: timestamp, expiresAt: timestamp, snapshot: snapshotSchema,
}).strict();

const candidateSchema = z.object({
  kind: z.literal('CONFLUENCE_RETAINED_COPY_REVIEW_CANDIDATE'),
  authorisesProviderIO: z.literal(false), snapshotSha256: hash, review: reviewSchema,
}).strict();

export type RetainedConfluenceCopyReviewCandidate = z.infer<typeof candidateSchema>;
export type RetainedConfluenceCopySnapshot = z.infer<typeof snapshotSchema>;
type Snapshot = RetainedConfluenceCopySnapshot;

function invalid(): never {
  throw new AppError(400, 'CONFLUENCE_COPY_REVIEW_INVALID',
    'A complete explicit synthetic copy review with retained primary evidence is required.');
}
function stale(): never {
  throw new AppError(409, 'CONFLUENCE_COPY_REVIEW_STALE',
    'The reviewed copy, source, inventory or review time has changed. Obtain a new review.');
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid();
  return result.data;
}
function canonicalSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    inventory: {
      ...snapshot.inventory, pageVersions: [...snapshot.inventory.pageVersions].sort((a, b) => a - b),
      attachments: snapshot.inventory.attachments.map((a) => ({
        ...a, versions: [...a.versions].sort((a, b) => a.number - b.number),
      })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    },
  };
}
function snapshotHash(snapshot: Snapshot): string {
  // A fresh observation of identical content is allowed. Its time is checked
  // separately; every source/target/version/byte identity remains bound.
  const { observedAt: _observedAt, ...inventory } = canonicalSnapshot(snapshot).inventory;
  return createHash('sha256').update(JSON.stringify({ ...snapshot, inventory })).digest('hex');
}

/** Validate/canonicalise observed facts only; this is not a review or permission. */
export function parseRetainedConfluenceCopySnapshot(value: unknown): RetainedConfluenceCopySnapshot {
  return canonicalSnapshot(parse(snapshotSchema, value));
}
function checkTimes(review: z.infer<typeof reviewSchema>, now: Date): void {
  const time = now.getTime();
  if (!Number.isFinite(time)) invalid();
  if (Date.parse(review.snapshot.inventory.observedAt) > Date.parse(review.reviewedAt)
    || Date.parse(review.reviewedAt) > time || Date.parse(review.expiresAt) <= time
    || Date.parse(review.snapshot.sourceRevision) > Date.parse(review.snapshot.inventory.observedAt)
    || Date.parse(review.snapshot.publicationRevision) > Date.parse(review.snapshot.inventory.observedAt)) stale();
}

/**
 * Review preparation ONLY. No actor authentication, durable authority, SQL
 * lock, legal-hold lookup or provider call occurs here. A caller-supplied
 * complete/synthetic flag is an assertion to review, not proof. The candidate
 * must never be passed to an eraser as permission. Transactional authority,
 * withdrawal, one-use execution and independent recovery are separate gates.
 */
export function prepareRetainedConfluenceCopyReview(
  input: unknown, now: Date,
): RetainedConfluenceCopyReviewCandidate {
  const review = parse(reviewSchema, input);
  checkTimes(review, now);
  review.snapshot = canonicalSnapshot(review.snapshot);
  return {
    kind: 'CONFLUENCE_RETAINED_COPY_REVIEW_CANDIDATE', authorisesProviderIO: false,
    snapshotSha256: snapshotHash(review.snapshot), review,
  };
}

/** A content/revision comparison, never a permission or inventory collector. */
export function assertRetainedConfluenceCopyReviewCurrent(
  candidateValue: unknown, currentValue: unknown, now: Date,
): void {
  const candidate = parse(candidateSchema, candidateValue);
  checkTimes(candidate.review, now);
  const current = parse(snapshotSchema, currentValue);
  const observed = Date.parse(current.inventory.observedAt);
  if (observed < Date.parse(candidate.review.reviewedAt)
    || observed > now.getTime()
    || Date.parse(current.sourceRevision) > observed
    || Date.parse(current.publicationRevision) > observed
    || snapshotHash(candidate.review.snapshot) !== candidate.snapshotSha256
    || snapshotHash(current) !== candidate.snapshotSha256) stale();
}
