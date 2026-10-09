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

/** Immutable candidate storage. createSourceFact must be provider-atomic
 * create-if-absent; a read-then-overwrite implementation is forbidden. */
export interface ComplaintSourceCandidateObjects {
  readSourceFact(operationId: string): Promise<string | null>;
  createSourceFact(operationId: string, envelope: string): Promise<boolean>;
}

/** Candidate publication does not advance a trusted head or authorize a
 * source mutation. Unknown writes must retry the same operation identity. */
export async function preserveComplaintSourceCandidate(body: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys, store: ComplaintSourceCandidateObjects) {
  try {
    const context = validateRecoveryEnvelopeContext(rawContext);
    requireFact(body, context);
    let envelope = await store.readSourceFact(context.operationId);
    let replayed = envelope !== null;
    if (envelope === null) {
      const candidate = await sealComplaintSourceFact(body, context, keys);
      replayed = !(await store.createSourceFact(context.operationId, candidate.envelope));
      envelope = await store.readSourceFact(context.operationId);
    }
    if (envelope === null || (await openComplaintSourceFact(envelope, context, keys)).body !== body) {
      throw new Error('conflict');
    }
    return { digest: createHash('sha256').update(envelope, 'utf8').digest('hex'),
      replayed, bindingAuthorized: false as const };
  } catch { throw new Error('Complaint source candidate preservation is unresolved'); }
}

/** The digest must come from separately authenticated history. Never derive it
 * from the fetched envelope or a restored local database alone. */
export async function readVerifiedComplaintSourceFact(expectedDigest: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  store: Pick<ComplaintSourceCandidateObjects, 'readSourceFact'>) {
  try {
    const context = validateRecoveryEnvelopeContext(rawContext);
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('digest');
    const envelope = await store.readSourceFact(context.operationId);
    if (envelope === null || Buffer.byteLength(envelope, 'utf8') > 65536
      || createHash('sha256').update(envelope, 'utf8').digest('hex') !== expectedDigest) {
      throw new Error('missing or replaced');
    }
    return await openComplaintSourceFact(envelope, context, keys);
  } catch { throw new Error('Referenced complaint source fact is unresolved'); }
}
