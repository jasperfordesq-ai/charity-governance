import { createHash } from 'node:crypto';
import { z } from 'zod';
import { openIntegrationSecret, sealIntegrationSecret } from './integration-crypto.js';
import { prepareComplaintRecoveryFacts, type ComplaintRecoveryFacts } from './complaint-recovery-preparation.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const contextSchema = z.object({ installationId: id, organisationId: id, operationId: id,
  writerEpoch: z.number().int().positive().max(2147483647),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  keyId: z.string().regex(/^arn:aws:kms:eu-west-1:[0-9]{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
}).strict();
export type RecoveryEnvelopeContext = z.infer<typeof contextSchema>;
export function validateRecoveryEnvelopeContext(raw: unknown): RecoveryEnvelopeContext {
  const result = contextSchema.safeParse(raw);
  if (!result.success) throw new Error('Invalid recovery envelope context');
  return result.data;
}
const base64 = (max: number) => z.string().min(1).max(max).refine(value => Buffer.from(value, 'base64').toString('base64') === value);
const envelopeSchema = z.object({ format: z.literal(1), kind: z.literal('COMPLAINT_RECOVERY_PREPARATION'),
  context: contextSchema, wrappedKey: base64(8192), sealed: z.object({
    generation: z.number().int().positive(), iv: base64(16), tag: base64(24), ciphertext: base64(43692),
  }).strict(),
}).strict();

/** Trusted provider boundary. Generate a fresh AES-256 data key, wrapping it with
 * this exact key ID and context; unwrap must enforce the same binding. Returned
 * key buffers transfer ownership and must not be cached/shared. No live adapter
 * or credentials are supplied by this module. Context contains IDs, never reasons. */
export interface RecoveryDataKeys {
  generate(context: RecoveryEnvelopeContext): Promise<{ key: Buffer; keyId: string; wrappedKey: string }>;
  unwrap(wrappedKey: string, context: RecoveryEnvelopeContext): Promise<{ key: Buffer; keyId: string }>;
}

/** Structural inspection only; authenticated opening is still required. */
export function inspectRecoveryPreparationEnvelope(body: string) {
  try {
    if (Buffer.byteLength(body, 'utf8') > 65536) throw new Error('oversized');
    const value = envelopeSchema.parse(JSON.parse(body));
    // Reject ignored duplicate JSON keys and extra representations that could
    // smuggle plaintext alongside otherwise valid encrypted fields.
    if (JSON.stringify(value) !== body) throw new Error('noncanonical');
    return value.context;
  } catch { throw new Error('Invalid recovery preparation envelope'); }
}

export interface RecoveryEnvelopeObjects {
  readReplay(operationId: string): Promise<string | null>;
  /** Atomic create-if-absent; false means an existing immutable object won. */
  createReplay(operationId: string, envelope: string): Promise<boolean>;
}

/** Publish only a candidate blob, never an intent/head or execution permission.
 * Unknown writes require retrying this operation, not changing its identity. */
export async function preserveRecoveryPreparation(body: string, context: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, store: RecoveryEnvelopeObjects) {
  try {
    context = contextSchema.parse(context);
    requireFacts(body, context);
    let envelope = await store.readReplay(context.operationId);
    let replayed = envelope !== null;
    if (envelope === null) {
      const candidate = await sealRecoveryPreparation(body, context, keys);
      replayed = !(await store.createReplay(context.operationId, candidate.envelope));
      // Read the winning bytes even after a conditional conflict. Never return
      // the local candidate's digest unless those are the actual stored bytes.
      envelope = await store.readReplay(context.operationId);
    }
    if (envelope === null || (await openRecoveryPreparation(envelope, context, keys)).body !== body) throw new Error('conflict');
    return { digest: createHash('sha256').update(envelope, 'utf8').digest('hex'), replayed,
      actionAuthorized: false as const };
  } catch { throw new Error('Recovery envelope preservation is unresolved; retry the same operation identity'); }
}

function secretContext(context: RecoveryEnvelopeContext, wrappedKey: string) {
  return { organisationId: context.organisationId, provider: 'charitypilot-recovery-envelope-v1',
    kind: JSON.stringify({ format: 1, kind: 'COMPLAINT_RECOVERY_PREPARATION', context, wrappedKey }) };
}

function requireFacts(body: string, context: RecoveryEnvelopeContext) {
  if (Buffer.byteLength(body, 'utf8') > 32768) throw new Error('oversized');
  const prepared = prepareComplaintRecoveryFacts(JSON.parse(body));
  const facts = JSON.parse(prepared.body) as ComplaintRecoveryFacts;
  if (prepared.body !== body || facts.installationId !== context.installationId
    || facts.organisationId !== context.organisationId || facts.operationId !== context.operationId
    || facts.writerEpoch !== context.writerEpoch || facts.sourceRevision !== context.sourceRevision) throw new Error('binding');
}

/** Candidate encryption only. Does not publish, persist an envelope, reserve an
 * epoch or authorize a claim. Caller must retain original bytes on every retry. */
export async function sealRecoveryPreparation(body: string, rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys) {
  let key: Buffer | undefined;
  try {
    const context = contextSchema.parse(rawContext);
    requireFacts(body, context);
    const generated = await keys.generate(context);
    key = generated.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || generated.keyId !== context.keyId) throw new Error('key');
    const wrappedKey = base64(8192).parse(generated.wrappedKey);
    const sealed = sealIntegrationSecret(body, key, context.writerEpoch, secretContext(context, wrappedKey));
    const envelope = JSON.stringify(envelopeSchema.parse({ format: 1, kind: 'COMPLAINT_RECOVERY_PREPARATION', context, wrappedKey, sealed }));
    return { envelope, digest: createHash('sha256').update(envelope, 'utf8').digest('hex'), actionAuthorized: false as const };
  } catch { throw new Error('Recovery preparation could not be encrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}

export async function openRecoveryPreparation(envelope: string, rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys) {
  let key: Buffer | undefined;
  try {
    if (Buffer.byteLength(envelope, 'utf8') > 65536) throw new Error('oversized');
    const context = contextSchema.parse(rawContext);
    const value = envelopeSchema.parse(JSON.parse(envelope));
    if (JSON.stringify(value) !== envelope) throw new Error('noncanonical');
    if (JSON.stringify(value.context) !== JSON.stringify(context) || value.sealed.generation !== context.writerEpoch) throw new Error('binding');
    const result = await keys.unwrap(value.wrappedKey, context);
    key = result.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || result.keyId !== context.keyId) throw new Error('key');
    const body = openIntegrationSecret(value.sealed, key, secretContext(context, value.wrappedKey));
    requireFacts(body, context);
    return { body, actionAuthorized: false as const };
  } catch { throw new Error('Recovery preparation could not be decrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}
