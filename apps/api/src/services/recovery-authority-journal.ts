import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Adapter must supply authenticated, strongly consistent reads and atomic
 * create-if-absent writes. Never implement create as read-then-overwrite.
 * Provider durability, independent custody and retention are separate gates. */
export interface AuthorityObjectStore {
  read(key: string): Promise<string | null>;
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
const kinds = z.enum(['DISPOSAL_INTENT', 'DISPOSAL_RESULT', 'PRESERVATION_CHANGE', 'CONTROL_CHANGE']);
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
const inputSchema = z.object({ operationId: identity, kind: kinds, factsDigest: digest,
  expectedGeneration: z.number().int().nonnegative().max(9999), expectedDigest: digest.nullable(),
}).strict().refine(v => (v.expectedGeneration === 0) === (v.expectedDigest === null));
const entrySchema = z.object({ format: z.literal(1), installationId: identity, organisationId: identity,
  generation: z.number().int().positive().max(10000), previousDigest: digest.nullable(),
  operationId: identity, kind: kinds, factsDigest: digest, digest,
}).strict();
type Entry = z.infer<typeof entrySchema>;
type Input = z.infer<typeof inputSchema>;
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const unsigned = (entry: Omit<Entry, 'digest'>) => JSON.stringify({ format: entry.format,
  installationId: entry.installationId, organisationId: entry.organisationId,
  generation: entry.generation, previousDigest: entry.previousDigest,
  operationId: entry.operationId, kind: entry.kind, factsDigest: entry.factsDigest });

/** Intent-journal primitive only. Receipts are not permission to perform an
 * action or reopen an application. Full facts/reconciliation, genesis trust,
 * anti-truncation authority and the live provider integration remain required. */
export class RecoveryAuthorityJournal {
  private readonly binding: z.infer<typeof bindingSchema>;
  private readonly checkpoint: AuthorityCheckpoint;
  /** Checkpoint must come from separately trusted custody, never this journal's
   * own unverified scan. It is a minimum known history, not proof of freshness.
   * Generation zero is permitted only for explicitly authorized initialization. */
  constructor(private readonly store: AuthorityObjectStore, binding: z.infer<typeof bindingSchema>,
    checkpoint: AuthorityCheckpoint) {
    this.binding = bindingSchema.parse(binding);
    this.checkpoint = checkpointSchema.parse(checkpoint);
    if (this.checkpoint.installationId !== this.binding.installationId ||
      this.checkpoint.organisationId !== this.binding.organisationId) {
      throw new Error('Recovery authority checkpoint binding mismatch');
    }
  }

  private key(generation: number) {
    return `authority/${this.binding.installationId}/${this.binding.organisationId}/${String(generation).padStart(10, '0')}.json`;
  }

  private async history(): Promise<Entry[]> {
    const rows: Entry[] = []; const operations = new Set<string>();
    for (let generation = 1; generation <= 10001; generation++) {
      let body: string | null;
      try { body = await this.store.read(this.key(generation)); }
      catch { throw new Error('Recovery authority is unavailable; keep dependent actions closed.'); }
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
      if (entry.installationId !== this.binding.installationId || entry.organisationId !== this.binding.organisationId ||
        entry.generation !== generation || entry.previousDigest !== (rows.at(-1)?.digest ?? null) ||
        entry.digest !== hash(unsigned(entry)) || operations.has(entry.operationId)) {
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
    return result.data;
  }

  /** Verifies complete observed history against two live head reads. Another
   * writer may advance immediately afterwards: callers still need action fencing.
   * No claim of freshness is valid without the HeadSource provider contract. */
  async inspectCurrent(source: AuthorityHeadSource) {
    const before = await this.readCurrentHead(source);
    const observed = await this.inspect();
    if (observed.generation !== before.generation || observed.digest !== before.digest) {
      throw new Error('Recovery authority history does not match its current head');
    }
    const after = await this.readCurrentHead(source);
    if (after.revision !== before.revision || after.generation !== before.generation || after.digest !== before.digest) {
      throw new Error('Recovery authority current head changed during verification');
    }
    return { ...observed, revision: after.revision };
  }

  private receipt(entry: Entry, replayed: boolean) {
    return { generation: entry.generation, digest: entry.digest, replayed, actionAuthorized: false as const };
  }

  private prior(rows: Entry[], input: Input) {
    const previous = rows.find(row => row.operationId === input.operationId);
    if (previous && (previous.kind !== input.kind || previous.factsDigest !== input.factsDigest ||
      previous.generation !== input.expectedGeneration + 1 || previous.previousDigest !== input.expectedDigest)) {
      throw new Error('Recovery operation identity was already used for different facts.');
    }
    return previous;
  }

  async append(raw: Input) {
    const input = inputSchema.parse(raw); const rows = await this.history();
    const previous = this.prior(rows, input);
    if (previous) return this.receipt(previous, true);
    if (input.expectedGeneration !== rows.length || input.expectedDigest !== (rows.at(-1)?.digest ?? null)) {
      throw new Error('Recovery authority generation changed; review current decisions.');
    }
    const facts = { format: 1 as const, ...this.binding, generation: rows.length + 1,
      previousDigest: input.expectedDigest, operationId: input.operationId, kind: input.kind, factsDigest: input.factsDigest };
    const entry: Entry = { ...facts, digest: hash(unsigned(facts)) };
    let created: boolean;
    try { created = await this.store.create(this.key(entry.generation), JSON.stringify(entry)); }
    catch { throw new Error('Recovery write outcome is unknown; retry the same operation identity.'); }
    let observed: Entry | undefined;
    try { observed = this.prior(await this.history(), input); }
    catch { throw new Error('Recovery write outcome is unknown; retry the same operation identity.'); }
    if (!observed) {
      if (!created) throw new Error('Recovery authority generation changed; review current decisions.');
      throw new Error('Recovery write outcome is unknown; retry the same operation identity.');
    }
    return this.receipt(observed, !created);
  }
}
