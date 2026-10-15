import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sealIntegrationSecret, openIntegrationSecret } from './integration-crypto.js';
import { prepareConfluenceCopyRecoveryFacts, CONFLUENCE_COPY_RECOVERY_MAX_FACT_BYTES } from './confluence-copy-recovery-facts.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';

export const CONFLUENCE_COPY_RECOVERY_MAX_ENVELOPE_BYTES = 32 * 1024 * 1024;
const base64 = (max: number) => z.string().min(1).max(max)
  .refine((v) => Buffer.from(v, 'base64').toString('base64') === v);
const schema = z.object({ format: z.literal(1), kind: z.literal('CONFLUENCE_COPY_DECISION_STATE_V1'),
  context: z.unknown().transform(validateRecoveryEnvelopeContext), wrappedKey: base64(8192),
  sealed: z.object({ generation: z.number().int().positive().max(2147483647), iv: base64(16), tag: base64(24),
    ciphertext: base64(Math.ceil(CONFLUENCE_COPY_RECOVERY_MAX_FACT_BYTES / 3) * 4) }).strict(),
}).strict();
const digest = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
function inspect(body: string) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > CONFLUENCE_COPY_RECOVERY_MAX_ENVELOPE_BYTES) throw new Error();
  const value = schema.parse(JSON.parse(body));
  if (JSON.stringify(value) !== body) throw new Error();
  return value;
}
export function inspectConfluenceCopyRecoveryEnvelope(body: string) {
  try { return inspect(body).context; }
  catch { throw new Error('Invalid Confluence copy recovery envelope'); }
}
function requireFacts(body: string, context: RecoveryEnvelopeContext) {
  if (Buffer.byteLength(body, 'utf8') > CONFLUENCE_COPY_RECOVERY_MAX_FACT_BYTES) throw new Error();
  const prepared = prepareConfluenceCopyRecoveryFacts(JSON.parse(body));
  const facts = JSON.parse(prepared.body);
  if (body !== prepared.body || facts.installationId !== context.installationId || facts.organisationId !== context.organisationId
    || facts.operationId !== context.operationId || facts.writerEpoch !== context.writerEpoch || facts.sourceRevision !== context.sourceRevision) throw new Error();
}
function secretContext(context: RecoveryEnvelopeContext, wrappedKey: string) {
  return { organisationId: context.organisationId, provider: 'charitypilot-confluence-copy-state-v1',
    kind: JSON.stringify({ format: 1, kind: 'CONFLUENCE_COPY_DECISION_STATE_V1', context, wrappedKey }) };
}

/** Authenticated metadata preservation, never publication/reopening authority. */
export async function sealConfluenceCopyRecoveryFacts(body: string, rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys) {
  let key: Buffer | undefined;
  try {
    const context = validateRecoveryEnvelopeContext(rawContext); requireFacts(body, context);
    const generated = await keys.generate(context); key = generated.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || generated.keyId !== context.keyId) throw new Error();
    const wrappedKey = base64(8192).parse(generated.wrappedKey);
    const sealed = sealIntegrationSecret(body, key, context.writerEpoch, secretContext(context, wrappedKey));
    const envelope = JSON.stringify(schema.parse({ format: 1, kind: 'CONFLUENCE_COPY_DECISION_STATE_V1', context, wrappedKey, sealed }));
    inspect(envelope);
    return { envelope, digest: digest(envelope), actionAuthorized: false as const };
  } catch { throw new Error('Confluence copy recovery facts could not be encrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}
export async function openConfluenceCopyRecoveryFacts(envelope: string, rawContext: RecoveryEnvelopeContext, keys: RecoveryDataKeys) {
  let key: Buffer | undefined;
  try {
    const context = validateRecoveryEnvelopeContext(rawContext), value = inspect(envelope);
    if (JSON.stringify(value.context) !== JSON.stringify(context) || value.sealed.generation !== context.writerEpoch) throw new Error();
    const unwrapped = await keys.unwrap(value.wrappedKey, context); key = unwrapped.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || unwrapped.keyId !== context.keyId) throw new Error();
    const body = openIntegrationSecret(value.sealed, key, secretContext(context, value.wrappedKey));
    requireFacts(body, context);
    return { body, actionAuthorized: false as const };
  } catch { throw new Error('Confluence copy recovery facts could not be decrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}
export interface ConfluenceCopyRecoveryObjects {
  readConfluenceCopyState(operationId: string): Promise<string | null>;
  createConfluenceCopyState(operationId: string, envelope: string): Promise<boolean>;
}
export async function preserveConfluenceCopyRecoveryFacts(body: string, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, store: ConfluenceCopyRecoveryObjects) {
  try {
    const context = validateRecoveryEnvelopeContext(rawContext); requireFacts(body, context);
    let envelope = await store.readConfluenceCopyState(context.operationId), replayed = envelope !== null;
    if (envelope === null) {
      const candidate = await sealConfluenceCopyRecoveryFacts(body, context, keys);
      replayed = !(await store.createConfluenceCopyState(context.operationId, candidate.envelope));
      envelope = await store.readConfluenceCopyState(context.operationId);
    }
    if (envelope === null || (await openConfluenceCopyRecoveryFacts(envelope, context, keys)).body !== body) throw new Error();
    return { digest: digest(envelope), replayed, actionAuthorized: false as const };
  } catch { throw new Error('Confluence recovery preservation unresolved; retry the original operation identity'); }
}
/** Expected digest must come from separately authenticated current history.
 * This reader authenticates a single object; it cannot prove that history.
 */
export async function readVerifiedConfluenceCopyRecoveryFacts(expectedDigest: string, rawContext: RecoveryEnvelopeContext,
  keys: RecoveryDataKeys, store: Pick<ConfluenceCopyRecoveryObjects, 'readConfluenceCopyState'>) {
  try {
    const context = validateRecoveryEnvelopeContext(rawContext);
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error();
    const envelope = await store.readConfluenceCopyState(context.operationId);
    if (envelope === null || digest(envelope) !== expectedDigest) throw new Error();
    const opened = await openConfluenceCopyRecoveryFacts(envelope, context, keys);
    return { body: opened.body, actionAuthorized: false as const, currentHistoryVerified: false as const, reopeningAuthorised: false as const };
  } catch { throw new Error('Published Confluence copy recovery facts are missing or invalid'); }
}
