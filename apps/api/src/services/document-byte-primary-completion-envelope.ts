import { createHash } from 'node:crypto';
import { z } from 'zod';
import { openIntegrationSecret, sealIntegrationSecret } from './integration-crypto.js';
import { prepareDocumentBytePrimaryCompletionFacts } from './document-byte-primary-completion.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys } from './recovery-preparation-envelope.js';

const base64 = (max: number) => z.string().min(1).max(max)
  .refine(v => Buffer.from(v, 'base64').toString('base64') === v);
const envelopeSchema = z.object({ format: z.literal(1),
  kind: z.literal('DOCUMENT_BYTE_PRIMARY_COMPLETION'),
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

export function inspectDocumentBytePrimaryCompletionEnvelope(body: string) {
  try { return inspect(body).context; }
  catch { throw new Error('Invalid document byte primary completion envelope'); }
}

function requireFacts(body: string, context: RecoveryEnvelopeContext) {
  if (Buffer.byteLength(body, 'utf8') > 4096) throw new Error('oversized');
  const prepared = prepareDocumentBytePrimaryCompletionFacts(JSON.parse(body));
  const facts = JSON.parse(prepared.body);
  if (prepared.body !== body || facts.installationId !== context.installationId
    || facts.organisationId !== context.organisationId || facts.operationId !== context.operationId
    || facts.writerEpoch !== context.writerEpoch || facts.sourceRevision !== context.sourceRevision) {
    throw new Error('binding');
  }
}

function secretContext(context: RecoveryEnvelopeContext, wrappedKey: string) {
  return { organisationId: context.organisationId, provider: 'charitypilot-document-byte-primary-completion-v1',
    kind: JSON.stringify({ format: 1, kind: 'DOCUMENT_BYTE_PRIMARY_COMPLETION', context, wrappedKey }) };
}

export async function sealDocumentBytePrimaryCompletion(body: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys) {
  let key: Buffer | undefined;
  try {
    const context = validateRecoveryEnvelopeContext(rawContext); requireFacts(body, context);
    const generated = await keys.generate(context); key = generated.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || generated.keyId !== context.keyId) throw new Error('key');
    const wrappedKey = base64(8192).parse(generated.wrappedKey);
    const sealed = sealIntegrationSecret(body, key, context.writerEpoch, secretContext(context, wrappedKey));
    const envelope = JSON.stringify(envelopeSchema.parse({ format: 1,
      kind: 'DOCUMENT_BYTE_PRIMARY_COMPLETION', context, wrappedKey, sealed }));
    return { envelope, digest: hash(envelope), actionAuthorized: false as const };
  } catch { throw new Error('Document byte primary completion could not be encrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}

export async function openDocumentBytePrimaryCompletion(envelope: string,
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
  } catch { throw new Error('Document byte primary completion could not be decrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}

export interface DocumentBytePrimaryCompletionObjects {
  readDocumentBytePrimaryCompletion(operationId: string): Promise<string | null>;
  createDocumentBytePrimaryCompletion(operationId: string, envelope: string): Promise<boolean>;
}

/** Immutable encrypted primary-object completion body. It certifies no other
 * copy and never releases the operation reservation. */
export async function preserveDocumentBytePrimaryCompletion(body: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  store: DocumentBytePrimaryCompletionObjects) {
  try {
    const context = validateRecoveryEnvelopeContext(rawContext); requireFacts(body, context);
    let envelope = await store.readDocumentBytePrimaryCompletion(context.operationId);
    let replayed = envelope !== null;
    if (envelope === null) {
      const candidate = await sealDocumentBytePrimaryCompletion(body, context, keys);
      replayed = !(await store.createDocumentBytePrimaryCompletion(context.operationId, candidate.envelope));
      envelope = await store.readDocumentBytePrimaryCompletion(context.operationId);
    }
    if (envelope === null || (await openDocumentBytePrimaryCompletion(envelope, context, keys)).body !== body) {
      throw new Error('conflict');
    }
    return { digest: hash(envelope), replayed, actionAuthorized: false as const };
  } catch { throw new Error('Document byte primary completion preservation unresolved; retry the same operation'); }
}

/** Expected digest must come from authenticated published current history. */
export async function readVerifiedDocumentBytePrimaryCompletion(expectedDigest: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  store: Pick<DocumentBytePrimaryCompletionObjects, 'readDocumentBytePrimaryCompletion'>) {
  try {
    const context = validateRecoveryEnvelopeContext(rawContext);
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('digest');
    const envelope = await store.readDocumentBytePrimaryCompletion(context.operationId);
    if (envelope === null || Buffer.byteLength(envelope, 'utf8') > 32768
      || hash(envelope) !== expectedDigest) throw new Error('missing or replaced');
    return await openDocumentBytePrimaryCompletion(envelope, context, keys);
  } catch { throw new Error('Referenced document byte primary completion is unresolved'); }
}
