import { createHash } from 'node:crypto';
import { z } from 'zod';
import { openIntegrationSecret, sealIntegrationSecret } from './integration-crypto.js';
import { MAX_DISPOSAL_OUTCOME_BYTES, prepareDocumentDisposalOutcomeFacts } from './document-disposal-outcome.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys } from './recovery-preparation-envelope.js';

const base64 = (max: number) => z.string().min(1).max(max)
  .refine(v => Buffer.from(v, 'base64').toString('base64') === v);
const envelopeSchema = z.object({ format: z.literal(1),
  kind: z.literal('DOCUMENT_DISPOSAL_OUTCOME'),
  context: z.unknown().transform(validateRecoveryEnvelopeContext), wrappedKey: base64(8192),
  sealed: z.object({ generation: z.number().int().positive(), iv: base64(16),
    tag: base64(24), ciphertext: base64(10924) }).strict(),
}).strict();
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');

function inspect(body: string) {
  if (Buffer.byteLength(body, 'utf8') > 32768) throw new Error('oversized');
  const value = envelopeSchema.parse(JSON.parse(body));
  if (JSON.stringify(value) !== body) throw new Error('noncanonical');
  return value;
}

export function inspectDocumentDisposalOutcomeEnvelope(body: string) {
  try { return inspect(body).context; }
  catch { throw new Error('Invalid document disposal outcome envelope'); }
}

function requireFacts(body: string, context: RecoveryEnvelopeContext) {
  if (Buffer.byteLength(body, 'utf8') > MAX_DISPOSAL_OUTCOME_BYTES) throw new Error('oversized');
  const prepared = prepareDocumentDisposalOutcomeFacts(JSON.parse(body));
  const facts = JSON.parse(prepared.body);
  if (prepared.body !== body || facts.installationId !== context.installationId
    || facts.organisationId !== context.organisationId || facts.operationId !== context.operationId
    || facts.writerEpoch !== context.writerEpoch || facts.sourceRevision !== context.sourceRevision) {
    throw new Error('binding');
  }
}

function secretContext(context: RecoveryEnvelopeContext, wrappedKey: string) {
  return { organisationId: context.organisationId, provider: 'charitypilot-document-disposal-outcome-v1',
    kind: JSON.stringify({ format: 1, kind: 'DOCUMENT_DISPOSAL_OUTCOME', context, wrappedKey }) };
}

export async function sealDocumentDisposalOutcome(body: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys) {
  let key: Buffer | undefined;
  try {
    const context = validateRecoveryEnvelopeContext(rawContext); requireFacts(body, context);
    const generated = await keys.generate(context); key = generated.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || generated.keyId !== context.keyId) throw new Error('key');
    const wrappedKey = base64(8192).parse(generated.wrappedKey);
    const sealed = sealIntegrationSecret(body, key, context.writerEpoch, secretContext(context, wrappedKey));
    const envelope = JSON.stringify(envelopeSchema.parse({ format: 1,
      kind: 'DOCUMENT_DISPOSAL_OUTCOME', context, wrappedKey, sealed }));
    return { envelope, digest: hash(envelope), actionAuthorized: false as const };
  } catch { throw new Error('Document disposal outcome could not be encrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}

export async function openDocumentDisposalOutcome(envelope: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys) {
  let key: Buffer | undefined;
  try {
    const context = validateRecoveryEnvelopeContext(rawContext), value = inspect(envelope);
    if (JSON.stringify(value.context) !== JSON.stringify(context)
      || value.sealed.generation !== context.writerEpoch) throw new Error('binding');
    const opened = await keys.unwrap(value.wrappedKey, context); key = opened.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || opened.keyId !== context.keyId) throw new Error('key');
    const body = openIntegrationSecret(value.sealed, key, secretContext(context, value.wrappedKey));
    requireFacts(body, context);
    return { body, actionAuthorized: false as const };
  } catch { throw new Error('Document disposal outcome could not be decrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}

export interface DocumentDisposalOutcomeObjects {
  readDocumentDisposalOutcome(operationId: string): Promise<string | null>;
  createDocumentDisposalOutcome(operationId: string, envelope: string): Promise<boolean>;
}

/** Immutable encrypted whole-case disposal outcome body. It deletes or
 * retains nothing; it is the evidence a document operation is released on. */
export async function preserveDocumentDisposalOutcome(body: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  store: DocumentDisposalOutcomeObjects) {
  try {
    const context = validateRecoveryEnvelopeContext(rawContext); requireFacts(body, context);
    let envelope = await store.readDocumentDisposalOutcome(context.operationId);
    let replayed = envelope !== null;
    if (envelope === null) {
      const candidate = await sealDocumentDisposalOutcome(body, context, keys);
      replayed = !(await store.createDocumentDisposalOutcome(context.operationId, candidate.envelope));
      envelope = await store.readDocumentDisposalOutcome(context.operationId);
    }
    if (envelope === null || (await openDocumentDisposalOutcome(envelope, context, keys)).body !== body) {
      throw new Error('conflict');
    }
    return { digest: hash(envelope), replayed, actionAuthorized: false as const };
  } catch { throw new Error('Document disposal outcome preservation unresolved; retry the same operation'); }
}

/** Expected digest must come from authenticated published current history. */
export async function readVerifiedDocumentDisposalOutcome(expectedDigest: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  store: Pick<DocumentDisposalOutcomeObjects, 'readDocumentDisposalOutcome'>) {
  try {
    const context = validateRecoveryEnvelopeContext(rawContext);
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('digest');
    const envelope = await store.readDocumentDisposalOutcome(context.operationId);
    if (envelope === null || Buffer.byteLength(envelope, 'utf8') > 32768
      || hash(envelope) !== expectedDigest) throw new Error('missing or replaced');
    return await openDocumentDisposalOutcome(envelope, context, keys);
  } catch { throw new Error('Referenced document disposal outcome is unresolved'); }
}
