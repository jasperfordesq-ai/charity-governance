import { createHash } from 'node:crypto';
import { z } from 'zod';
import { openIntegrationSecret, sealIntegrationSecret } from './integration-crypto.js';
import { prepareDocumentRecoveryFacts } from './document-recovery-preparation.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys } from './recovery-preparation-envelope.js';

const base64 = (max: number) => z.string().min(1).max(max)
  .refine(value => Buffer.from(value, 'base64').toString('base64') === value);
const envelopeSchema = z.object({ format: z.literal(1), kind: z.literal('DOCUMENT_PURGE_PREPARATION'),
  context: z.unknown().transform(validateRecoveryEnvelopeContext), wrappedKey: base64(8192),
  sealed: z.object({ generation: z.number().int().positive(), iv: base64(16),
    tag: base64(24), ciphertext: base64(43692) }).strict(),
}).strict();

function inspect(body: string) {
  if (Buffer.byteLength(body, 'utf8') > 65536) throw new Error('oversized');
  const value = envelopeSchema.parse(JSON.parse(body));
  if (JSON.stringify(value) !== body) throw new Error('noncanonical');
  return value;
}

/** Structural inspection for the provider boundary; opening authenticates bytes. */
export function inspectDocumentRecoveryEnvelope(body: string) {
  try { return inspect(body).context; }
  catch { throw new Error('Invalid document recovery envelope'); }
}

function requireFacts(body: string, context: RecoveryEnvelopeContext) {
  if (Buffer.byteLength(body, 'utf8') > 32768) throw new Error('oversized');
  const prepared = prepareDocumentRecoveryFacts(JSON.parse(body));
  const facts = JSON.parse(prepared.body);
  if (prepared.body !== body || facts.installationId !== context.installationId
    || facts.organisationId !== context.organisationId || facts.operationId !== context.operationId
    || facts.writerEpoch !== context.writerEpoch || facts.sourceRevision !== context.sourceRevision) {
    throw new Error('binding');
  }
}

function secretContext(context: RecoveryEnvelopeContext, wrappedKey: string) {
  return { organisationId: context.organisationId, provider: 'charitypilot-document-preparation-v1',
    kind: JSON.stringify({ format: 1, kind: 'DOCUMENT_PURGE_PREPARATION', context, wrappedKey }) };
}

/** Encryption alone never grants authority to claim or erase a document. */
export async function sealDocumentRecoveryPreparation(body: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys) {
  let key: Buffer | undefined;
  try {
    const context = validateRecoveryEnvelopeContext(rawContext);
    requireFacts(body, context);
    const generated = await keys.generate(context); key = generated.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || generated.keyId !== context.keyId) throw new Error('key');
    const wrappedKey = base64(8192).parse(generated.wrappedKey);
    const sealed = sealIntegrationSecret(body, key, context.writerEpoch, secretContext(context, wrappedKey));
    const envelope = JSON.stringify(envelopeSchema.parse({ format: 1, kind: 'DOCUMENT_PURGE_PREPARATION',
      context, wrappedKey, sealed }));
    return { envelope, digest: createHash('sha256').update(envelope, 'utf8').digest('hex'),
      actionAuthorized: false as const };
  } catch { throw new Error('Document recovery preparation could not be encrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}

export async function openDocumentRecoveryPreparation(envelope: string,
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
  } catch { throw new Error('Document recovery preparation could not be decrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}

export interface DocumentRecoveryObjects {
  readDocumentPreparation(operationId: string): Promise<string | null>;
  createDocumentPreparation(operationId: string, envelope: string): Promise<boolean>;
}

/** Candidate preservation. An unknown write is retried under the same identity.
 * A published read must instead use independently verified history/digest. */
export async function preserveDocumentRecoveryPreparation(body: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys, store: DocumentRecoveryObjects) {
  try {
    const context = validateRecoveryEnvelopeContext(rawContext);
    requireFacts(body, context);
    let envelope = await store.readDocumentPreparation(context.operationId);
    let replayed = envelope !== null;
    if (envelope === null) {
      const candidate = await sealDocumentRecoveryPreparation(body, context, keys);
      replayed = !(await store.createDocumentPreparation(context.operationId, candidate.envelope));
      envelope = await store.readDocumentPreparation(context.operationId);
    }
    if (envelope === null || (await openDocumentRecoveryPreparation(envelope, context, keys)).body !== body) {
      throw new Error('conflict');
    }
    return { digest: createHash('sha256').update(envelope, 'utf8').digest('hex'),
      replayed, actionAuthorized: false as const };
  } catch { throw new Error('Document recovery preparation preservation unresolved; retry original operation'); }
}

/** A digest from current, independently verified history is required. Never
 * recreate a missing published envelope from a restored local database. */
export async function readVerifiedDocumentRecoveryPreparation(expectedDigest: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  store: Pick<DocumentRecoveryObjects, 'readDocumentPreparation'>) {
  try {
    const context = validateRecoveryEnvelopeContext(rawContext);
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('digest');
    const envelope = await store.readDocumentPreparation(context.operationId);
    if (envelope === null || Buffer.byteLength(envelope, 'utf8') > 65536
      || createHash('sha256').update(envelope, 'utf8').digest('hex') !== expectedDigest) {
      throw new Error('missing or replaced');
    }
    return await openDocumentRecoveryPreparation(envelope, context, keys);
  } catch { throw new Error('Referenced document recovery preparation is unresolved'); }
}
