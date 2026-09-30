import { createHash } from 'node:crypto';
import { z } from 'zod';
import { openIntegrationSecret, sealIntegrationSecret } from './integration-crypto.js';
import { prepareComplaintHoldRecoveryFacts } from './complaint-hold-recovery-preparation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';

const base64 = (max: number) => z.string().min(1).max(max)
  .refine(v => Buffer.from(v, 'base64').toString('base64') === v);
const envelopeSchema = z.object({ format: z.literal(1), kind: z.literal('COMPLAINT_HOLD_PREPARATION'),
  context: z.unknown().transform(validateRecoveryEnvelopeContext), wrappedKey: base64(8192),
  sealed: z.object({ generation: z.number().int().positive(), iv: base64(16), tag: base64(24), ciphertext: base64(10924) }).strict(),
}).strict();
function inspect(body: string) {
  if (Buffer.byteLength(body, 'utf8') > 32768) throw new Error('oversized');
  const value = envelopeSchema.parse(JSON.parse(body));
  if (JSON.stringify(value) !== body) throw new Error('noncanonical');
  return value;
}
export function inspectHoldPreparationEnvelope(body: string) {
  try { return inspect(body).context; }
  catch { throw new Error('Invalid hold preparation envelope'); }
}
function requireFacts(body: string, context: RecoveryEnvelopeContext) {
  if (Buffer.byteLength(body, 'utf8') > 8192) throw new Error('oversized');
  const parsed = prepareComplaintHoldRecoveryFacts(JSON.parse(body));
  const facts = JSON.parse(parsed.body);
  if (parsed.body !== body || facts.installationId !== context.installationId
    || facts.organisationId !== context.organisationId || facts.operationId !== context.operationId
    || facts.writerEpoch !== context.writerEpoch || facts.sourceRevision !== context.sourceRevision) throw new Error('binding');
}
function secretContext(context: RecoveryEnvelopeContext, wrappedKey: string) {
  return { organisationId: context.organisationId, provider: 'charitypilot-hold-preparation-v1',
    kind: JSON.stringify({ format: 1, kind: 'COMPLAINT_HOLD_PREPARATION', context, wrappedKey }) };
}
export async function sealHoldPreparation(body: string, rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys) {
  let key: Buffer | undefined;
  try {
    const context = validateRecoveryEnvelopeContext(rawContext); requireFacts(body, context);
    const generated = await keys.generate(context); key = generated.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || generated.keyId !== context.keyId) throw new Error('key');
    const wrappedKey = base64(8192).parse(generated.wrappedKey);
    const sealed = sealIntegrationSecret(body, key, context.writerEpoch, secretContext(context, wrappedKey));
    const envelope = JSON.stringify(envelopeSchema.parse({ format: 1, kind: 'COMPLAINT_HOLD_PREPARATION', context, wrappedKey, sealed }));
    return { envelope, digest: createHash('sha256').update(envelope).digest('hex'), actionAuthorized: false as const };
  } catch { throw new Error('Hold preparation could not be encrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}
export async function openHoldPreparation(envelope: string, rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys) {
  let key: Buffer | undefined;
  try {
    const context = validateRecoveryEnvelopeContext(rawContext), value = inspect(envelope);
    if (JSON.stringify(value.context) !== JSON.stringify(context) || value.sealed.generation !== context.writerEpoch) throw new Error('binding');
    const opened = await keys.unwrap(value.wrappedKey, context); key = opened.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || opened.keyId !== context.keyId) throw new Error('key');
    const body = openIntegrationSecret(value.sealed, key, secretContext(context, value.wrappedKey));
    requireFacts(body, context); return { body, actionAuthorized: false as const };
  } catch { throw new Error('Hold preparation could not be decrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}
export interface HoldPreparationObjects {
  readHoldPreparation(operationId: string): Promise<string | null>;
  createHoldPreparation(operationId: string, envelope: string): Promise<boolean>;
}
/** Digest must come from independently verified published history. Never derive
 * it solely from the fetched envelope or restored local database. No fallback
 * creates a replacement if published hold-preparation bytes have disappeared. */
export async function readVerifiedHoldPreparation(expectedDigest: string, context: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, store: Pick<HoldPreparationObjects, 'readHoldPreparation'>) {
  try {
    context = validateRecoveryEnvelopeContext(context);
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('digest');
    const envelope = await store.readHoldPreparation(context.operationId);
    if (envelope === null || Buffer.byteLength(envelope, 'utf8') > 32768
      || createHash('sha256').update(envelope).digest('hex') !== expectedDigest) throw new Error('missing or replaced');
    return await openHoldPreparation(envelope, context, keys);
  } catch { throw new Error('Referenced hold preparation is unresolved'); }
}
/** Candidate preservation only. Published readers must require a trusted digest;
 * this method cannot distinguish first creation from later object loss. */
export async function preserveHoldPreparation(body: string, context: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, store: HoldPreparationObjects) {
  try {
    context = validateRecoveryEnvelopeContext(context); requireFacts(body, context);
    let envelope = await store.readHoldPreparation(context.operationId), replayed = envelope !== null;
    if (envelope === null) {
      const candidate = await sealHoldPreparation(body, context, keys);
      replayed = !(await store.createHoldPreparation(context.operationId, candidate.envelope));
      envelope = await store.readHoldPreparation(context.operationId);
    }
    if (envelope === null || (await openHoldPreparation(envelope, context, keys)).body !== body) throw new Error('conflict');
    return { digest: createHash('sha256').update(envelope).digest('hex'), replayed, actionAuthorized: false as const };
  } catch { throw new Error('Hold preparation preservation unresolved; retry the same operation identity'); }
}
