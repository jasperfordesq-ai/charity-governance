import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateRecoveryControl, type RecoveryControlStore } from './recovery-operation-reservation.js';

/** Adapter must supply authenticated, strongly consistent reads and atomic
 * create-if-absent writes. Never implement create as read-then-overwrite.
 * Provider durability, independent custody and retention are separate gates. */
export interface AuthorityObjectStore {
  read(key: string, signal?: AbortSignal): Promise<string | null>;
  create(key: string, body: string): Promise<boolean>;
}

/** Must read the live, authenticated independent head without caches or fallback
 * to a backup/checkpoint. Revision is the provider's non-reused version identity.
 * A stable read is an observation, never a lock or disposal/reopen authorization. */
export interface AuthorityHeadSource {
  readHead(): Promise<unknown>;
}

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const kinds = z.enum(['DISPOSAL_INTENT', 'DISPOSAL_RESULT', 'PRESERVATION_CHANGE', 'CONTROL_CHANGE',
  'COMPLAINT_PREPARATION_V1', 'COMPLAINT_OUTCOME_V1', 'COMPLAINT_HOLD_PREPARATION_V1', 'COMPLAINT_HOLD_OUTCOME_V1',
  'COMPLAINT_CANCELLATION_V1', 'COMPLAINT_HOLD_CANCELLATION_V1', 'DOCUMENT_PREPARATION_V1', 'DOCUMENT_OUTCOME_V1',
  'DOCUMENT_BYTE_PERMIT_V1', 'DOCUMENT_BYTE_EXECUTION_DECISION_V1',
  'DOCUMENT_BYTE_PROVIDER_UNKNOWN_V1', 'DOCUMENT_BYTE_PRIMARY_COMPLETION_V1']);
const bindingSchema = z.object({ installationId: identity, organisationId: identity }).strict();
const checkpointFields = {
  generation: z.number().int().nonnegative().max(10000), digest: digest.nullable(),
};
const checkpointSchema = bindingSchema.extend(checkpointFields)
  .strict().refine(v => (v.generation === 0) === (v.digest === null));
const headSchema = bindingSchema.extend({ ...checkpointFields,
  revision: z.string().min(1).max(1024).regex(/^[\x21-\x7e]+$/),
}).strict().refine(v => (v.generation === 0) === (v.digest === null));
export type AuthorityCheckpoint = z.infer<typeof checkpointSchema>;
/** Replace an existing head only if its revision still matches. This must be a
 * provider-atomic conditional write, with a new revision on every success.
 * Provisioning the initial head is a separate explicitly authorized operation. */
export interface AuthorityHeadPublisher extends AuthorityHeadSource {
  compareAndSwap(expectedRevision: string, next: AuthorityCheckpoint): Promise<boolean>;
}
const inputSchema = z.object({ operationId: identity, kind: kinds, factsDigest: digest,
  expectedGeneration: z.number().int().nonnegative().max(9999), expectedDigest: digest.nullable(),
}).strict().refine(v => (v.expectedGeneration === 0) === (v.expectedDigest === null));
const entrySchema = z.object({ format: z.literal(1), installationId: identity, organisationId: identity,
  generation: z.number().int().positive().max(10000), previousDigest: digest.nullable(),
  operationId: identity, kind: kinds, factsDigest: digest, digest,
}).strict();
type Entry = z.infer<typeof entrySchema>;
type Input = z.infer<typeof inputSchema>;
// Admit a multi-entry operation only when its longest required decision chain
// fits before the current journal ceiling. This is a stopgap until a reviewed
// rollover protocol exists; unused slots are not an authorization to act.
const admissionSlots: Partial<Record<Entry['kind'], number>> = {
  DISPOSAL_INTENT: 2,
  COMPLAINT_PREPARATION_V1: 2,
  COMPLAINT_HOLD_PREPARATION_V1: 2,
  DOCUMENT_PREPARATION_V1: 6,
};
const predecessorKind = (kind: Entry['kind']): Entry['kind'] | undefined => {
  if (kind === 'COMPLAINT_OUTCOME_V1' || kind === 'COMPLAINT_CANCELLATION_V1') return 'COMPLAINT_PREPARATION_V1';
  if (kind === 'COMPLAINT_HOLD_OUTCOME_V1' || kind === 'COMPLAINT_HOLD_CANCELLATION_V1') return 'COMPLAINT_HOLD_PREPARATION_V1';
  if (kind === 'DOCUMENT_OUTCOME_V1') return 'DOCUMENT_PREPARATION_V1';
  if (kind === 'DOCUMENT_BYTE_PERMIT_V1') return 'DOCUMENT_OUTCOME_V1';
  if (kind === 'DOCUMENT_BYTE_EXECUTION_DECISION_V1') return 'DOCUMENT_BYTE_PERMIT_V1';
  if (kind === 'DOCUMENT_BYTE_PROVIDER_UNKNOWN_V1') return 'DOCUMENT_BYTE_EXECUTION_DECISION_V1';
  // A completion always follows the published UNKNOWN: a started attempt is
  // possible I/O until reconciled, so the chain stays linear and nothing can
  // complete without first recording that uncertainty independently.
  if (kind === 'DOCUMENT_BYTE_PRIMARY_COMPLETION_V1') return 'DOCUMENT_BYTE_PROVIDER_UNKNOWN_V1';
  return undefined;
};
const isAncestorKind = (ancestor: Entry['kind'], kind: Entry['kind']) => {
  for (let predecessor = predecessorKind(kind); predecessor !== undefined;
    predecessor = predecessorKind(predecessor)) {
    if (predecessor === ancestor) return true;
  }
  return false;
};
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const unsigned = (entry: Omit<Entry, 'digest'>) => JSON.stringify({ format: entry.format,
  installationId: entry.installationId, organisationId: entry.organisationId,
  generation: entry.generation, previousDigest: entry.previousDigest,
  operationId: entry.operationId, kind: entry.kind, factsDigest: entry.factsDigest });

/** One entry's structure/hash only; this does not verify its chain or freshness. */
export function validateRecoveryAuthorityEntry(raw: unknown) {
  const entry = entrySchema.parse(raw);
  if (entry.digest !== hash(unsigned(entry))) throw new Error('Invalid recovery authority entry digest');
  return entry;
}

/** Intent-journal primitive only. Receipts are not permission to perform an
 * action or reopen an application. Full facts/reconciliation, genesis trust,
 * anti-truncation authority and the live provider integration remain required. */
export class RecoveryAuthorityJournal {
  private readonly binding: z.infer<typeof bindingSchema>;
  private readonly checkpoint: AuthorityCheckpoint;
  private readonly appendVerification: 'FULL' | 'VERIFIED_PREFIX';
  private verifiedPrefix: Entry[] = [];
  private prefixReusable = false;
  /** Checkpoint must come from separately trusted custody, never this journal's
   * own unverified scan. It is a minimum known history, not proof of freshness.
   * Generation zero is permitted only for explicitly authorized initialization. */
  constructor(private readonly store: AuthorityObjectStore, binding: z.infer<typeof bindingSchema>,
    checkpoint: AuthorityCheckpoint, options = { appendVerification: 'FULL' as 'FULL' | 'VERIFIED_PREFIX' }) {
    this.binding = bindingSchema.parse(binding);
    this.checkpoint = checkpointSchema.parse(checkpoint);
    this.appendVerification = z.object({ appendVerification: z.enum(['FULL', 'VERIFIED_PREFIX']) })
      .strict().parse(options).appendVerification;
    if (this.checkpoint.installationId !== this.binding.installationId ||
      this.checkpoint.organisationId !== this.binding.organisationId) {
      throw new Error('Recovery authority checkpoint binding mismatch');
    }
  }

  private key(generation: number) {
    return `authority/${this.binding.installationId}/${this.binding.organisationId}/${String(generation).padStart(10, '0')}.json`;
  }

  /** Prefix reuse is opt-in and assumes independently enforced immutable entry
   * storage. It does not re-audit historical bytes before the boundary on each
   * append. Recovery inspection always traverses the complete chain. */
  private async history(reusePrefix = false): Promise<Entry[]> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Recovery authority verification deadline exceeded'));
      }, 30000);
    });
    try {
      const prefix = reusePrefix && this.appendVerification === 'VERIFIED_PREFIX' && this.prefixReusable
        ? this.verifiedPrefix : [];
      const rows = await this.scanHistory(controller.signal, expired, prefix);
      if (this.appendVerification === 'VERIFIED_PREFIX') {
        if (rows.length < this.verifiedPrefix.length) {
          throw new Error('Previously verified history is truncated');
        }
        const previous = this.verifiedPrefix.at(-1);
        if (previous && rows[previous.generation - 1]?.digest !== previous.digest) {
          throw new Error('Previously verified recovery history changed');
        }
        this.verifiedPrefix = rows;
        this.prefixReusable = true;
      }
      return rows;
    } catch (error) { this.prefixReusable = false; throw error; }
    finally { clearTimeout(timer!); controller.abort(); }
  }

  private async readBody(generation: number, signal: AbortSignal, expired: Promise<never>) {
    let body: string | null;
    try { body = await Promise.race([this.store.read(this.key(generation), signal), expired]); }
    catch {
      if (signal.aborted) throw new Error('Recovery authority verification deadline exceeded');
      throw new Error('Recovery authority is unavailable; keep dependent actions closed.');
    }
    if (signal.aborted) throw new Error('Recovery authority verification deadline exceeded');
    return body;
  }

  private async scanHistory(signal: AbortSignal, expired: Promise<never>, prefix: Entry[]): Promise<Entry[]> {
    const rows = [...prefix]; const operations = new Set(prefix.map(row => row.operationId));
    const boundary = prefix.at(-1);
    if (boundary) {
      const body = await this.readBody(boundary.generation, signal, expired);
      try {
        if (body === null || body.length > 4096) throw new Error('Missing boundary');
        const observed = entrySchema.parse(JSON.parse(body));
        if (observed.digest !== boundary.digest || hash(unsigned(observed)) !== boundary.digest) {
          throw new Error('Changed boundary');
        }
      } catch { throw new Error('Previously verified recovery authority boundary is missing or changed'); }
    }
    for (let generation = prefix.length + 1; generation <= 10001; generation++) {
      const body = await this.readBody(generation, signal, expired);
      if (body === null) {
        if (rows.length < this.checkpoint.generation) {
          throw new Error('Recovery authority history is shorter than its trusted checkpoint');
        }
        return rows;
      }
      if (generation > 10000) break;
      if (body.length > 4096) throw new Error('Invalid recovery authority entry');
      let entry: Entry;
      try { entry = entrySchema.parse(JSON.parse(body)); }
      catch { throw new Error('Invalid recovery authority entry'); }
      const expectedPredecessor = predecessorKind(entry.kind);
      const followsPredecessor = expectedPredecessor !== undefined
        && rows.at(-1)?.kind === expectedPredecessor
        && rows.at(-1)?.operationId === entry.operationId;
      if (entry.installationId !== this.binding.installationId || entry.organisationId !== this.binding.organisationId ||
        entry.generation !== generation || entry.previousDigest !== (rows.at(-1)?.digest ?? null) ||
        entry.digest !== hash(unsigned(entry)) || (operations.has(entry.operationId) && !followsPredecessor)
        || (expectedPredecessor !== undefined && !followsPredecessor)) {
        throw new Error('Invalid recovery authority binding or chain');
      }
      if (generation === this.checkpoint.generation && entry.digest !== this.checkpoint.digest) {
        throw new Error('Recovery authority does not match its trusted checkpoint');
      }
      operations.add(entry.operationId); rows.push(entry);
    }
    throw new Error('Recovery authority scan limit reached; keep dependent actions closed.');
  }

  async inspect() {
    const rows = await this.history(); const head = rows.at(-1);
    return { generation: rows.length, digest: head?.digest ?? null, actionAuthorized: false as const };
  }

  private async readCurrentHead(source: AuthorityHeadSource) {
    let raw: unknown;
    try { raw = await source.readHead(); }
    catch { throw new Error('Recovery authority current head is unavailable'); }
    const result = headSchema.safeParse(raw);
    if (!result.success || result.data.installationId !== this.binding.installationId ||
      result.data.organisationId !== this.binding.organisationId) {
      throw new Error('Invalid recovery authority current head');
    }
    if (result.data.generation < this.checkpoint.generation ||
      (result.data.generation === this.checkpoint.generation && result.data.digest !== this.checkpoint.digest)) {
      throw new Error('Recovery authority current head contradicts its trusted checkpoint');
    }
    return result.data;
  }

  /** Verifies complete observed history against two live head reads. Another
   * writer may advance immediately afterwards: callers still need action fencing.
   * No claim of freshness is valid without the HeadSource provider contract. */
  async inspectCurrent(source: AuthorityHeadSource) {
    const { rows, revision } = await this.currentHistory(source);
    return { generation: rows.length, digest: rows.at(-1)?.digest ?? null,
      actionAuthorized: false as const, revision };
  }

  /** Obtain an immutable entry only after full current-history verification.
   * The caller must interpret factsDigest using the entry's explicit protocol;
   * format 1 does not itself specify an encrypted payload or permit execution. */
  async readPublishedEntry(operationId: string, kind: z.infer<typeof kinds>, source: AuthorityHeadSource) {
    identity.parse(operationId); kinds.parse(kind);
    const { rows, revision } = await this.currentHistory(source);
    const entry = rows.find(row => row.operationId === operationId && row.kind === kind);
    if (!entry) throw new Error('Requested recovery entry is not published');
    return { entry: { ...entry }, revision, actionAuthorized: false as const };
  }

  /** A reserved append writes its entry, then advances the head. A crash
   * between the two leaves one entry beyond the head, and every reader above
   * refuses that history. This returns that pending entry and the head entry
   * it follows, only when it is the exact next generation for this operation
   * and kind. It says nothing about the entry's facts: the caller must
   * authenticate its envelope before resuming the same append. */
  async readPendingEntry(operationId: string, kind: z.infer<typeof kinds>, source: AuthorityHeadSource) {
    identity.parse(operationId); kinds.parse(kind);
    const before = await this.readCurrentHead(source);
    const rows = await this.history();
    this.headMatchesHistory(before, rows);
    const pending = rows[before.generation];
    if (rows.length !== before.generation + 1 || !pending
      || pending.operationId !== operationId || pending.kind !== kind) {
      throw new Error('No exact pending recovery entry');
    }
    const after = await this.readCurrentHead(source);
    if (after.revision !== before.revision || after.generation !== before.generation) {
      throw new Error('Recovery authority current head changed during verification');
    }
    const head = rows[before.generation - 1];
    return { pending: { ...pending }, head: head ? { ...head } : null, revision: before.revision,
      actionAuthorized: false as const };
  }

  private async currentHistory(source: AuthorityHeadSource) {
    const before = await this.readCurrentHead(source);
    const rows = await this.history();
    const observed = { generation: rows.length, digest: rows.at(-1)?.digest ?? null };
    if (observed.generation !== before.generation || observed.digest !== before.digest) {
      throw new Error('Recovery authority history does not match its current head');
    }
    const after = await this.readCurrentHead(source);
    if (after.revision !== before.revision || after.generation !== before.generation || after.digest !== before.digest) {
      throw new Error('Recovery authority current head changed during verification');
    }
    return { rows, revision: after.revision };
  }

  private receipt(entry: Entry, replayed: boolean) {
    return { generation: entry.generation, digest: entry.digest, replayed, actionAuthorized: false as const };
  }

  private prior(rows: Entry[], input: Input) {
    const previous = rows.find(row => row.operationId === input.operationId && row.kind === input.kind);
    if (rows.some(row => row.operationId === input.operationId && row.kind !== input.kind
      && !isAncestorKind(row.kind, input.kind) && !isAncestorKind(input.kind, row.kind))) {
      throw new Error('Recovery operation identity was already used for different facts.');
    }
    if (previous && (previous.kind !== input.kind || previous.factsDigest !== input.factsDigest ||
      previous.generation !== input.expectedGeneration + 1 || previous.previousDigest !== input.expectedDigest)) {
      throw new Error('Recovery operation identity was already used for different facts.');
    }
    return previous;
  }

  private headMatchesHistory(head: AuthorityCheckpoint, rows: Entry[]) {
    if (head.generation > rows.length ||
      head.digest !== (head.generation === 0 ? null : rows[head.generation - 1]?.digest)) {
      throw new Error('Recovery authority history does not match its current head');
    }
  }

  /** Publishes one exact intent, resuming either interrupted durable boundary.
   * A head receipt still cannot authorize action: later holds need fencing. */
  async appendPublished(raw: Input, publisher: AuthorityHeadPublisher) {
    const input = inputSchema.parse(raw);
    const before = await this.readCurrentHead(publisher);
    const rows = await this.history(true);
    this.headMatchesHistory(before, rows);
    const previous = this.prior(rows, input);
    if (previous && previous.generation <= before.generation) {
      return { ...this.receipt(previous, true), headPublished: true as const };
    }
    if (before.generation !== input.expectedGeneration || before.digest !== input.expectedDigest) {
      throw new Error('Recovery authority generation changed; review current decisions.');
    }
    if (rows.length > before.generation && (!previous || rows.length !== previous.generation)) {
      throw new Error('Recovery authority has unresolved pending history; reconcile the exact operation.');
    }
    const receipt = await this.appendIntent(input, true);
    const next = { ...this.binding, generation: receipt.generation, digest: receipt.digest };
    let published: boolean;
    try { published = await publisher.compareAndSwap(before.revision, next); }
    catch { throw new Error('Recovery publication outcome is unknown; retry the same operation identity.'); }
    let after: z.infer<typeof headSchema>;
    try {
      after = await this.readCurrentHead(publisher);
      const currentRows = await this.history(true);
      this.headMatchesHistory(after, currentRows);
      if (currentRows[receipt.generation - 1]?.digest !== receipt.digest) {
        throw new Error('Intent changed');
      }
    } catch { throw new Error('Recovery publication outcome is unknown; retry the same operation identity.'); }
    if (after.generation < receipt.generation || after.revision === before.revision) {
      if (!published) throw new Error('Recovery authority generation changed; review current decisions.');
      throw new Error('Recovery publication outcome is unknown; retry the same operation identity.');
    }
    return { ...receipt, headPublished: true as const };
  }

  async append(raw: Input) {
    return this.appendIntent(raw, false);
  }

  /** Publish an already verified candidate envelope under its exact reservation.
   * This pins every head read/CAS to the writer, epoch and preparation facts.
   * The caller must first verify the encrypted candidate's content and digest;
   * this method only binds that digest into history. No release or execution
   * permission is produced, and no production action invokes this path. */
  async appendReservedComplaintPreparation(raw: unknown, control: RecoveryControlStore) {
    return this.appendReservedPreparation(raw, control, 'COMPLAINT_PREPARATION_V1');
  }

  async appendReservedHoldPreparation(raw: unknown, control: RecoveryControlStore) {
    return this.appendReservedPreparation(raw, control, 'COMPLAINT_HOLD_PREPARATION_V1');
  }

  async appendReservedDocumentPreparation(raw: unknown, control: RecoveryControlStore) {
    return this.appendReservedPreparation(raw, control, 'DOCUMENT_PREPARATION_V1');
  }

  private async appendReservedPreparation(raw: unknown, control: RecoveryControlStore,
    kind: 'COMPLAINT_PREPARATION_V1' | 'COMPLAINT_HOLD_PREPARATION_V1' | 'DOCUMENT_PREPARATION_V1') {
    const request = z.object({ operationId: identity, writerId: identity,
      writerEpoch: z.number().int().positive().max(2147483647), preparationDigest: digest,
      envelopeDigest: digest, expectedGeneration: z.number().int().nonnegative().max(9999),
      expectedDigest: digest.nullable(),
    }).strict().refine(v => (v.expectedGeneration === 0) === (v.expectedDigest === null)).parse(raw);
    const publisher = await this.complaintPublisher(request, control);
    return this.appendPublished({ operationId: request.operationId, kind,
      factsDigest: request.envelopeDigest, expectedGeneration: request.expectedGeneration,
      expectedDigest: request.expectedDigest }, publisher);
  }

  /** Caller must authenticate both envelopes and verify their exact facts before
   * supplying these digests. Publication keeps the reservation occupied. */
  async appendReservedComplaintOutcome(raw: unknown, control: RecoveryControlStore) {
    return this.appendReservedOutcome(raw, control, 'COMPLAINT_OUTCOME_V1');
  }

  async appendReservedDocumentOutcome(raw: unknown, control: RecoveryControlStore) {
    return this.appendReservedOutcome(raw, control, 'DOCUMENT_OUTCOME_V1');
  }

  /** A third-stage journal binding only. The caller must authenticate a
   * separate encrypted permit candidate and current local authority before
   * supplying its digest. This receipt never enables the byte worker. */
  async appendReservedDocumentBytePermit(raw: unknown, control: RecoveryControlStore) {
    const request = z.object({ operationId: identity, writerId: identity,
      writerEpoch: z.number().int().positive().max(2147483647), preparationDigest: digest,
      outcomeGeneration: z.number().int().positive().max(9999), outcomeEntryDigest: digest,
      outcomeEnvelopeDigest: digest, permitEnvelopeDigest: digest,
    }).strict().parse(raw);
    const publisher = await this.complaintPublisher(request, control);
    const before = await this.readCurrentHead(publisher), rows = await this.history();
    this.headMatchesHistory(before, rows);
    const outcome = rows[request.outcomeGeneration - 1];
    if (!outcome || outcome.kind !== 'DOCUMENT_OUTCOME_V1'
      || outcome.operationId !== request.operationId || outcome.digest !== request.outcomeEntryDigest
      || outcome.factsDigest !== request.outcomeEnvelopeDigest || before.generation < outcome.generation) {
      throw new Error('Document byte permit requires the exact published claim outcome');
    }
    return this.appendPublished({ operationId: request.operationId, kind: 'DOCUMENT_BYTE_PERMIT_V1',
      factsDigest: request.permitEnvelopeDigest, expectedGeneration: outcome.generation,
      expectedDigest: outcome.digest }, publisher);
  }

  /** Fourth-stage, distinct independent decision entry. A verified encrypted
   * decision body must supply the digest; this journal receipt does not let a
   * worker claim a job or call a provider. Keep the active reservation held. */
  async appendReservedDocumentByteExecutionDecision(raw: unknown, control: RecoveryControlStore) {
    const request = z.object({ operationId: identity, writerId: identity,
      writerEpoch: z.number().int().positive().max(2147483647), preparationDigest: digest,
      candidateGeneration: z.number().int().positive().max(9999), candidateEntryDigest: digest,
      candidateEnvelopeDigest: digest, decisionEnvelopeDigest: digest,
    }).strict().parse(raw);
    const publisher = await this.complaintPublisher(request, control);
    const before = await this.readCurrentHead(publisher), rows = await this.history();
    this.headMatchesHistory(before, rows);
    const candidate = rows[request.candidateGeneration - 1];
    if (!candidate || candidate.kind !== 'DOCUMENT_BYTE_PERMIT_V1'
      || candidate.operationId !== request.operationId || candidate.digest !== request.candidateEntryDigest
      || candidate.factsDigest !== request.candidateEnvelopeDigest || before.generation < candidate.generation) {
      throw new Error('Document byte execution decision requires the exact published candidate');
    }
    return this.appendPublished({ operationId: request.operationId,
      kind: 'DOCUMENT_BYTE_EXECUTION_DECISION_V1', factsDigest: request.decisionEnvelopeDigest,
      expectedGeneration: candidate.generation, expectedDigest: candidate.digest }, publisher);
  }

  /** Fifth-stage possible-I/O observation. Its encrypted facts must be
   * authenticated by the caller and tied to a committed SQL start marker.
   * This records uncertainty; it never authorizes another call or a retry. */
  async appendReservedDocumentByteProviderUnknown(raw: unknown, control: RecoveryControlStore) {
    const request = z.object({ operationId: identity, writerId: identity,
      writerEpoch: z.number().int().positive().max(2147483647), preparationDigest: digest,
      decisionGeneration: z.number().int().positive().max(9999), decisionEntryDigest: digest,
      decisionEnvelopeDigest: digest, unknownEnvelopeDigest: digest,
    }).strict().parse(raw);
    const publisher = await this.complaintPublisher(request, control);
    const before = await this.readCurrentHead(publisher), rows = await this.history();
    this.headMatchesHistory(before, rows);
    const decision = rows[request.decisionGeneration - 1];
    if (!decision || decision.kind !== 'DOCUMENT_BYTE_EXECUTION_DECISION_V1'
      || decision.operationId !== request.operationId || decision.digest !== request.decisionEntryDigest
      || decision.factsDigest !== request.decisionEnvelopeDigest || before.generation < decision.generation) {
      throw new Error('Document byte UNKNOWN requires the exact published decision');
    }
    return this.appendPublished({ operationId: request.operationId,
      kind: 'DOCUMENT_BYTE_PROVIDER_UNKNOWN_V1', factsDigest: request.unknownEnvelopeDigest,
      expectedGeneration: decision.generation, expectedDigest: decision.digest }, publisher);
  }

  /** Sixth-stage reconciled primary-object result. Its encrypted facts must be
   * authenticated by the caller against the published UNKNOWN and a recorded
   * provider observation. It covers the primary active object only; it never
   * releases the operation reservation or speaks for any other copy. */
  async appendReservedDocumentBytePrimaryCompletion(raw: unknown, control: RecoveryControlStore) {
    const request = z.object({ operationId: identity, writerId: identity,
      writerEpoch: z.number().int().positive().max(2147483647), preparationDigest: digest,
      unknownGeneration: z.number().int().positive().max(9999), unknownEntryDigest: digest,
      unknownEnvelopeDigest: digest, completionEnvelopeDigest: digest,
    }).strict().parse(raw);
    const publisher = await this.complaintPublisher(request, control);
    const before = await this.readCurrentHead(publisher), rows = await this.history();
    this.headMatchesHistory(before, rows);
    const unknown = rows[request.unknownGeneration - 1];
    if (!unknown || unknown.kind !== 'DOCUMENT_BYTE_PROVIDER_UNKNOWN_V1'
      || unknown.operationId !== request.operationId || unknown.digest !== request.unknownEntryDigest
      || unknown.factsDigest !== request.unknownEnvelopeDigest || before.generation < unknown.generation) {
      throw new Error('Document byte completion requires the exact published UNKNOWN');
    }
    return this.appendPublished({ operationId: request.operationId,
      kind: 'DOCUMENT_BYTE_PRIMARY_COMPLETION_V1', factsDigest: request.completionEnvelopeDigest,
      expectedGeneration: unknown.generation, expectedDigest: unknown.digest }, publisher);
  }

  async appendReservedHoldOutcome(raw: unknown, control: RecoveryControlStore) {
    return this.appendReservedOutcome(raw, control, 'COMPLAINT_HOLD_OUTCOME_V1');
  }

  async appendReservedComplaintCancellation(raw: unknown, control: RecoveryControlStore) {
    return this.appendReservedOutcome(raw, control, 'COMPLAINT_CANCELLATION_V1');
  }

  async appendReservedHoldCancellation(raw: unknown, control: RecoveryControlStore) {
    return this.appendReservedOutcome(raw, control, 'COMPLAINT_HOLD_CANCELLATION_V1');
  }

  private async appendReservedOutcome(raw: unknown, control: RecoveryControlStore,
    kind: 'COMPLAINT_OUTCOME_V1' | 'COMPLAINT_HOLD_OUTCOME_V1' | 'COMPLAINT_CANCELLATION_V1' | 'COMPLAINT_HOLD_CANCELLATION_V1' | 'DOCUMENT_OUTCOME_V1') {
    const request = z.object({ operationId: identity, writerId: identity,
      writerEpoch: z.number().int().positive().max(2147483647), preparationDigest: digest,
      preparationEnvelopeDigest: digest, preparationEntryDigest: digest,
      preparationGeneration: z.number().int().positive().max(9999), outcomeEnvelopeDigest: digest,
    }).strict().parse(raw);
    const publisher = await this.complaintPublisher(request, control);
    const before = await this.readCurrentHead(publisher), rows = await this.history();
    this.headMatchesHistory(before, rows);
    const preparation = rows[request.preparationGeneration - 1];
    if (!preparation || preparation.kind !== predecessorKind(kind)
      || preparation.operationId !== request.operationId || preparation.digest !== request.preparationEntryDigest
      || preparation.factsDigest !== request.preparationEnvelopeDigest || before.generation < preparation.generation) {
      throw new Error('Recovery outcome requires the exact published preparation');
    }
    return this.appendPublished({ operationId: request.operationId, kind,
      factsDigest: request.outcomeEnvelopeDigest, expectedGeneration: preparation.generation,
      expectedDigest: preparation.digest }, publisher);
  }

  private async complaintPublisher(request: { writerId: string; writerEpoch: number;
    operationId: string; preparationDigest: string }, control: RecoveryControlStore): Promise<AuthorityHeadPublisher> {
    const current = async () => {
      const value = validateRecoveryControl(await control.readControl());
      if (value.installationId !== this.binding.installationId || value.organisationId !== this.binding.organisationId
        || value.writerId !== request.writerId || value.writerEpoch !== request.writerEpoch
        || value.activeOperation?.operationId !== request.operationId
        || value.activeOperation.preparationDigest !== request.preparationDigest) {
        throw new Error('Recovery publication reservation does not match');
      }
      return value;
    };
    // Validate before the generic journal path so no intent can be written
    // without this reservation. Recheck on every later read and conditional write.
    await current();
    const publisher: AuthorityHeadPublisher = {
      readHead: async () => {
        const value = await current();
        return { ...this.binding, generation: value.generation, digest: value.digest, revision: value.revision };
      },
      compareAndSwap: async (expectedRevision, next) => {
        const { revision, ...value } = await current();
        if (revision !== expectedRevision) return false;
        return control.compareAndSwapControl(revision, { ...value, ...next });
      },
    };
    return publisher;
  }

  private async appendIntent(raw: Input, reusePrefix: boolean) {
    const input = inputSchema.parse(raw); const rows = await this.history(reusePrefix);
    const previous = this.prior(rows, input);
    if (previous) return this.receipt(previous, true);
    if (input.expectedGeneration !== rows.length || input.expectedDigest !== (rows.at(-1)?.digest ?? null)) {
      throw new Error('Recovery authority generation changed; review current decisions.');
    }
    if (rows.length + (admissionSlots[input.kind] ?? 1) > 10000) {
      throw new Error('Recovery authority capacity cannot admit the complete operation; keep dependent actions closed.');
    }
    const expectedPredecessor = predecessorKind(input.kind);
    if (expectedPredecessor !== undefined && (rows.at(-1)?.kind !== expectedPredecessor
      || rows.at(-1)?.operationId !== input.operationId)) {
      throw new Error('Recovery operation entry must immediately follow its exact predecessor');
    }
    const facts = { format: 1 as const, ...this.binding, generation: rows.length + 1,
      previousDigest: input.expectedDigest, operationId: input.operationId, kind: input.kind, factsDigest: input.factsDigest };
    const entry: Entry = { ...facts, digest: hash(unsigned(facts)) };
    let created: boolean;
    try { created = await this.store.create(this.key(entry.generation), JSON.stringify(entry)); }
    catch { throw new Error('Recovery write outcome is unknown; retry the same operation identity.'); }
    let observed: Entry | undefined;
    try { observed = this.prior(await this.history(reusePrefix), input); }
    catch { throw new Error('Recovery write outcome is unknown; retry the same operation identity.'); }
    if (!observed) {
      if (!created) throw new Error('Recovery authority generation changed; review current decisions.');
      throw new Error('Recovery write outcome is unknown; retry the same operation identity.');
    }
    return this.receipt(observed, !created);
  }
}
