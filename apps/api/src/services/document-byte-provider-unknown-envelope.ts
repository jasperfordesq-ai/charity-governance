import { createHash } from 'node:crypto';
import { z } from 'zod';
import { openIntegrationSecret, sealIntegrationSecret } from './integration-crypto.js';
import { prepareDocumentByteProviderUnknownFacts } from './document-byte-provider-unknown.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext,
  type RecoveryDataKeys } from './recovery-preparation-envelope.js';

const base64 = (max: number) => z.string().min(1).max(max)
  .refine(v => Buffer.from(v, 'base64').toString('base64') === v);
const envelopeSchema = z.object({ format: z.literal(1),
  kind: z.literal('DOCUMENT_BYTE_PROVIDER_UNKNOWN'),
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

export function inspectDocumentByteProviderUnknownEnvelope(body: string) {
  try { return inspect(body).context; }
  catch { throw new Error('Invalid document byte provider UNKNOWN envelope'); }
}

function requireFacts(body: string, context: RecoveryEnvelopeContext) {
  if (Buffer.byteLength(body, 'utf8') > 4096) throw new Error('oversized');
  const prepared = prepareDocumentByteProviderUnknownFacts(JSON.parse(body));
  const facts = JSON.parse(prepared.body);
  if (prepared.body !== body || facts.installationId !== context.installationId
    || facts.organisationId !== context.organisationId || facts.operationId !== context.operationId
    || facts.writerEpoch !== context.writerEpoch || facts.sourceRevision !== context.sourceRevision) {
    throw new Error('binding');
  }
}

function secretContext(context: RecoveryEnvelopeContext, wrappedKey: string) {
  return { organisationId: context.organisationId, provider: 'charitypilot-document-byte-provider-unknown-v1',
    kind: JSON.stringify({ format: 1, kind: 'DOCUMENT_BYTE_PROVIDER_UNKNOWN', context, wrappedKey }) };
}

export async function sealDocumentByteProviderUnknown(body: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys) {
  let key: Buffer | undefined;
  try {
    const context = validateRecoveryEnvelopeContext(rawContext); requireFacts(body, context);
    const generated = await keys.generate(context); key = generated.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || generated.keyId !== context.keyId) throw new Error('key');
    const wrappedKey = base64(8192).parse(generated.wrappedKey);
    const sealed = sealIntegrationSecret(body, key, context.writerEpoch, secretContext(context, wrappedKey));
    const envelope = JSON.stringify(envelopeSchema.parse({ format: 1,
      kind: 'DOCUMENT_BYTE_PROVIDER_UNKNOWN', context, wrappedKey, sealed }));
    return { envelope, digest: hash(envelope), actionAuthorized: false as const };
  } catch { throw new Error('Document byte provider UNKNOWN could not be encrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}

export async function openDocumentByteProviderUnknown(envelope: string,
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
  } catch { throw new Error('Document byte provider UNKNOWN could not be decrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}

export interface DocumentByteProviderUnknownObjects {
  readDocumentByteProviderUnknown(operationId: string): Promise<string | null>;
  createDocumentByteProviderUnknown(operationId: string, envelope: string): Promise<boolean>;
}

/** Immutable encrypted uncertainty body; it never permits a provider retry. */
export async function preserveDocumentByteProviderUnknown(body: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  store: DocumentByteProviderUnknownObjects) {
  try {
    const context = validateRecoveryEnvelopeContext(rawContext); requireFacts(body, context);
    let envelope = await store.readDocumentByteProviderUnknown(context.operationId);
    let replayed = envelope !== null;
    if (envelope === null) {
      const candidate = await sealDocumentByteProviderUnknown(body, context, keys);
      replayed = !(await store.createDocumentByteProviderUnknown(context.operationId, candidate.envelope));
      envelope = await store.readDocumentByteProviderUnknown(context.operationId);
    }
    if (envelope === null || (await openDocumentByteProviderUnknown(envelope, context, keys)).body !== body) {
      throw new Error('conflict');
    }
    return { digest: hash(envelope), replayed, actionAuthorized: false as const };
  } catch { throw new Error('Document byte provider UNKNOWN preservation unresolved; retry the same operation'); }
}

/** Expected digest must come from authenticated published current history. */
export async function readVerifiedDocumentByteProviderUnknown(expectedDigest: string,
  rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys,
  store: Pick<DocumentByteProviderUnknownObjects, 'readDocumentByteProviderUnknown'>) {
  try {
    const context = validateRecoveryEnvelopeContext(rawContext);
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('digest');
    const envelope = await store.readDocumentByteProviderUnknown(context.operationId);
    if (envelope === null || Buffer.byteLength(envelope, 'utf8') > 32768
      || hash(envelope) !== expectedDigest) throw new Error('missing or replaced');
    return await openDocumentByteProviderUnknown(envelope, context, keys);
  } catch { throw new Error('Referenced document byte provider UNKNOWN is unresolved'); }
}
