import { createHash } from 'node:crypto';
import { z } from 'zod';
import { openIntegrationSecret, sealIntegrationSecret } from './integration-crypto.js';
import { prepareComplaintSourceFact } from './complaint-source-fact.js';
import { validateRecoveryEnvelopeContext, type RecoveryDataKeys,
  type RecoveryEnvelopeContext } from './recovery-preparation-envelope.js';

const base64 = (max: number) => z.string().min(1).max(max)
  .refine(value => Buffer.from(value, 'base64').toString('base64') === value);
const envelopeSchema = z.object({
  format: z.literal(1), kind: z.literal('COMPLAINT_SOURCE_FACT_CANDIDATE'),
  context: z.object({ installationId: z.string(), organisationId: z.string(),
    operationId: z.string(), writerEpoch: z.number(), sourceRevision: z.string(), keyId: z.string() }).strict(),
  wrappedKey: base64(8192),
  sealed: z.object({ generation: z.number().int().positive(), iv: base64(16),
    tag: base64(24), ciphertext: base64(43692) }).strict(),
}).strict();

function requireFact(body: string, context: RecoveryEnvelopeContext) {
  const prepared = prepareComplaintSourceFact(JSON.parse(body));
  const fact = JSON.parse(prepared.body) as { installationId: string; organisationId: string;
    operationId: string; writerEpoch: number; sourceRevision: string };
  if (prepared.body !== body || fact.installationId !== context.installationId
    || fact.organisationId !== context.organisationId || fact.operationId !== context.operationId
    || fact.writerEpoch !== context.writerEpoch || fact.sourceRevision !== context.sourceRevision) {
    throw new Error('Complaint source envelope binding mismatch');
  }
}

function aad(context: RecoveryEnvelopeContext, wrappedKey: string) {
  return { organisationId: context.organisationId, provider: 'charitypilot-complaint-source-v1',
    kind: JSON.stringify({ format: 1, kind: 'COMPLAINT_SOURCE_FACT_CANDIDATE', context, wrappedKey }) };
}

/** Encrypts one synthetic candidate only. It publishes no history, proves no
 * custody or freshness, and cannot authorize a live recovery binding. */
export async function sealComplaintSourceFact(body: string, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys) {
  let key: Buffer | undefined;
  try {
    const context = validateRecoveryEnvelopeContext(rawContext);
    requireFact(body, context);
    const generated = await keys.generate(context);
    key = generated.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || generated.keyId !== context.keyId) throw new Error('key');
    const wrappedKey = base64(8192).parse(generated.wrappedKey);
    const sealed = sealIntegrationSecret(body, key, context.writerEpoch, aad(context, wrappedKey));
    const envelope = JSON.stringify(envelopeSchema.parse({ format: 1,
      kind: 'COMPLAINT_SOURCE_FACT_CANDIDATE', context, wrappedKey, sealed }));
    if (Buffer.byteLength(envelope, 'utf8') > 65536) throw new Error('oversized');
    return { envelope, digest: createHash('sha256').update(envelope, 'utf8').digest('hex'),
      bindingAuthorized: false as const };
  } catch { throw new Error('Complaint source fact could not be encrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}

/** Opens exact candidate bytes with the independently supplied context/key.
 * Callers must separately verify a trusted history digest and current head. */
export async function openComplaintSourceFact(envelope: string, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys) {
  let key: Buffer | undefined;
  try {
    if (Buffer.byteLength(envelope, 'utf8') > 65536) throw new Error('oversized');
    const context = validateRecoveryEnvelopeContext(rawContext);
    const value = envelopeSchema.parse(JSON.parse(envelope));
    if (JSON.stringify(value) !== envelope
      || JSON.stringify(value.context) !== JSON.stringify(context)
      || value.sealed.generation !== context.writerEpoch) throw new Error('binding');
    const result = await keys.unwrap(value.wrappedKey, context);
    key = result.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || result.keyId !== context.keyId) throw new Error('key');
    const body = openIntegrationSecret(value.sealed, key, aad(context, value.wrappedKey));
    requireFact(body, context);
    return { body, bindingAuthorized: false as const };
  } catch { throw new Error('Complaint source fact could not be decrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}
