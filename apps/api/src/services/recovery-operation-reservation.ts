import { z } from 'zod';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.number().int().positive().max(2147483647);
const binding = { installationId: identity, organisationId: identity };
const operationSchema = z.object({ operationId: identity, preparationDigest: digest }).strict();
const controlFields = { format: z.literal(2), ...binding,
  writerId: identity, writerEpoch: epoch,
  generation: z.number().int().nonnegative().max(10000), digest: digest.nullable(),
  activeOperation: operationSchema.nullable() };
const controlSchema = z.object({ ...controlFields,
  revision: z.string().min(1).max(1024).regex(/^[\x21-\x7e]+$/),
}).strict().refine(v => (v.generation === 0) === (v.digest === null));
const requestSchema = z.object({ ...binding, writerId: identity, writerEpoch: epoch,
  operationId: identity, preparationDigest: digest,
  expectedGeneration: z.number().int().nonnegative().max(9999), expectedDigest: digest.nullable(),
}).strict().refine(v => (v.expectedGeneration === 0) === (v.expectedDigest === null));
type Control = z.infer<typeof controlSchema>;
export type RecoveryControlValue = Omit<Control, 'revision'>;
export function validateRecoveryControlValue(raw: unknown): RecoveryControlValue {
  return z.object(controlFields).strict()
    .refine(v => (v.generation === 0) === (v.digest === null)).parse(raw);
}

/** Version-2 provider boundary, deliberately incompatible with the format-1
 * journal publisher. Must use the SAME authoritative control resource for all
 * reservations, journal publication and writer changes. Reads are authenticated,
 * uncached and strongly consistent; CAS is atomic with non-reused revisions.
 * Provider calls need bounded deadlines. No production adapter is wired yet. */
export interface RecoveryControlStore {
  readControl(): Promise<unknown>;
  compareAndSwapControl(expectedRevision: string, next: RecoveryControlValue): Promise<boolean>;
}

async function read(store: RecoveryControlStore): Promise<Control> {
  try { return controlSchema.parse(await store.readControl()); }
  catch { throw new Error('Recovery operation control is unavailable or invalid'); }
}

/** Reserve one exact preparation without expiry or takeover. This is NOT an
 * execution fence: local database enforcement and old-host isolation still need
 * integration. No initialization, writer replacement or release API is provided.
 * Release must eventually require a durably published exact operation outcome;
 * format-1 appendPublished must never be used alongside this control protocol.
 * preparationDigest binds canonical local facts; the later encrypted envelope
 * has its own digest. Never substitute one for the other. */
export async function reserveRecoveryOperation(raw: unknown, store: RecoveryControlStore) {
  const request = requestSchema.parse(raw);
  const before = await read(store);
  if (before.installationId !== request.installationId || before.organisationId !== request.organisationId) {
    throw new Error('Recovery operation control binding mismatch');
  }
  if (before.writerId !== request.writerId || before.writerEpoch !== request.writerEpoch) {
    throw new Error('Recovery operation writer is not current');
  }
  if (before.generation !== request.expectedGeneration || before.digest !== request.expectedDigest) {
    throw new Error('Recovery operation history changed');
  }
  const activeOperation = { operationId: request.operationId, preparationDigest: request.preparationDigest };
  const matches = (value: Control) => value.activeOperation !== null
    && value.activeOperation.operationId === activeOperation.operationId
    && value.activeOperation.preparationDigest === activeOperation.preparationDigest;
  if (before.activeOperation) {
    if (!matches(before)) throw new Error('Recovery operation control is occupied; reconcile the original operation');
    return { revision: before.revision, replayed: true, actionAuthorized: false as const };
  }
  const { revision, ...value } = before;
  const next = { ...value, activeOperation };
  let written: boolean;
  try { written = await store.compareAndSwapControl(revision, next); }
  catch { throw new Error('Recovery reservation outcome is unknown; retry the same operation identity'); }
  const after = await read(store);
  const { revision: afterRevision, ...afterValue } = after;
  if (afterRevision === revision || JSON.stringify(afterValue) !== JSON.stringify(next)) {
    throw new Error('Recovery operation reservation was not verified; reconcile current control');
  }
  return { revision: afterRevision, replayed: !written, actionAuthorized: false as const };
}
