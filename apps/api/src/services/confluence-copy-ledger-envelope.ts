import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sealIntegrationSecret, openIntegrationSecret } from './integration-crypto.js';
import { prepareConfluenceCopyLocalLedger, CONFLUENCE_COPY_LEDGER_MAX_BYTES } from './confluence-copy-ledger-snapshot.js';
import { validateRecoveryEnvelopeContext, type RecoveryEnvelopeContext, type RecoveryDataKeys } from './recovery-preparation-envelope.js';
import { validateRecoveryControl } from './recovery-operation-reservation.js';
import { validateConfluenceCopyLedgerRows } from './confluence-copy-ledger-validation.js';

export const CONFLUENCE_COPY_LEDGER_MAX_ENVELOPE_BYTES = 192 * 1024 * 1024;
const base64 = (max: number) => z.string().min(1).max(max)
  .refine(value => Buffer.from(value,'base64').toString('base64') === value);
const bindingSchema = z.object({ context: z.unknown().transform(validateRecoveryEnvelopeContext),
  observedControl: z.unknown().transform(validateRecoveryControl) }).strict()
  .refine(value => value.context.installationId === value.observedControl.installationId
    && value.context.organisationId === value.observedControl.organisationId
    && value.context.writerEpoch === value.observedControl.writerEpoch);
export type ConfluenceCopyLedgerArchiveBinding = { context: RecoveryEnvelopeContext; observedControl: unknown };
const schema = z.object({ format: z.literal(1), kind: z.literal('CONFLUENCE_COPY_LEDGER_ARCHIVE_V1'),
  binding: bindingSchema, wrappedKey: base64(8192), sealed: z.object({
    generation: z.number().int().positive().max(2147483647), iv: base64(16), tag: base64(24),
    ciphertext: base64(Math.ceil(CONFLUENCE_COPY_LEDGER_MAX_BYTES / 3) * 4),
  }).strict() }).strict();
const noAuthority = { actionAuthorized: false as const, currentHistoryVerified: false as const, reopeningAuthorised: false as const };
const digest = (body: string) => createHash('sha256').update(body,'utf8').digest('hex');
function inspect(envelope: string) {
  if (typeof envelope !== 'string' || Buffer.byteLength(envelope,'utf8') > CONFLUENCE_COPY_LEDGER_MAX_ENVELOPE_BYTES) throw new Error();
  const value = schema.parse(JSON.parse(envelope));
  if (JSON.stringify(value) !== envelope) throw new Error();
  return value;
}
export function inspectConfluenceCopyLedgerEnvelope(envelope: string) {
  try { return inspect(envelope).binding; }
  catch { throw new Error('Invalid Confluence ledger archive envelope'); }
}
function requireLedger(body: string, binding: z.infer<typeof bindingSchema>) {
  if (typeof body !== 'string' || Buffer.byteLength(body,'utf8') > CONFLUENCE_COPY_LEDGER_MAX_BYTES) throw new Error();
  const prepared = prepareConfluenceCopyLocalLedger(JSON.parse(body));
  if (prepared.body !== body || prepared.ledger.installationId !== binding.context.installationId
    || prepared.ledger.organisationId !== binding.context.organisationId
    || prepared.ledger.declaredSourceRevision !== binding.context.sourceRevision) throw new Error();
}
function secretContext(binding: z.infer<typeof bindingSchema>, wrappedKey: string) {
  return { organisationId: binding.context.organisationId, provider: 'charitypilot-confluence-copy-ledger-v1',
    kind: JSON.stringify({ format: 1, kind: 'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1', binding, wrappedKey }) };
}

/** Encrypts original local ledger plus a declared observed control binding.
 * This is a separate archive format, never a decision/outcome journal entry.
 * Caller must durably retain the original body/binding before external I/O.
 * No claim that the observed control is current or the ledger is complete in
 * time follows; supported publication/freshness/recovery gates remain separate.
 */
export async function sealConfluenceCopyLedgerArchive(body: string, raw: ConfluenceCopyLedgerArchiveBinding, keys: RecoveryDataKeys) {
  let key: Buffer | undefined;
  try {
    const binding = bindingSchema.parse(raw); requireLedger(body,binding);
    const generated = await keys.generate(binding.context); key = generated.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || generated.keyId !== binding.context.keyId) throw new Error();
    const wrappedKey = base64(8192).parse(generated.wrappedKey);
    const sealed = sealIntegrationSecret(body,key,binding.context.writerEpoch,secretContext(binding,wrappedKey));
    const envelope = JSON.stringify(schema.parse({ format: 1, kind: 'CONFLUENCE_COPY_LEDGER_ARCHIVE_V1', binding, wrappedKey, sealed }));
    inspect(envelope);
    return { envelope, digest: digest(envelope), ...noAuthority };
  } catch { throw new Error('Confluence ledger archive could not be encrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}
export async function openConfluenceCopyLedgerArchive(envelope: string, raw: ConfluenceCopyLedgerArchiveBinding, keys: Pick<RecoveryDataKeys,'unwrap'>) {
  let key: Buffer | undefined;
  try {
    const binding = bindingSchema.parse(raw), value = inspect(envelope);
    if (JSON.stringify(value.binding) !== JSON.stringify(binding) || value.sealed.generation !== binding.context.writerEpoch) throw new Error();
    const unwrapped = await keys.unwrap(value.wrappedKey,binding.context); key = unwrapped.key;
    if (!Buffer.isBuffer(key) || key.length !== 32 || unwrapped.keyId !== binding.context.keyId) throw new Error();
    const body = openIntegrationSecret(value.sealed,key,secretContext(binding,value.wrappedKey));
    requireLedger(body,binding);
    return { body, ...noAuthority };
  } catch { throw new Error('Confluence ledger archive could not be decrypted'); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}

export interface ConfluenceCopyLedgerObjects {
  readConfluenceCopyLedger(operationId: string): Promise<string | null>;
  createConfluenceCopyLedger(operationId: string, envelope: string): Promise<boolean>;
}

/** Pre-publication upload of an ALREADY durably saved candidate only. The
 * caller must persist the original capture AND exact envelope/digest before
 * invoking this helper. This function does not provide that persistence.
 * Published operations must use the expected-digest reader; a missing published
 * object must never be recreated through this creation-capable helper.
 * Unlike the legacy convenience helper below, this path never generates keys
 * or reseals an archive. A different valid encryption of the same body conflicts.
 */
export async function preservePreparedConfluenceCopyLedgerArchive(
  original: { body: string; digest: string; binding: ConfluenceCopyLedgerArchiveBinding },
  candidate: { envelope: string; digest: string },
  keys: Pick<RecoveryDataKeys,'unwrap'>,
  store: ConfluenceCopyLedgerObjects,
) {
  try {
    const binding = bindingSchema.parse(original.binding);
    const body = original.body, envelope = candidate.envelope, expectedDigest = candidate.digest;
    requireLedger(body,binding);
    validateConfluenceCopyLedgerRows(body,binding.context);
    if (digest(body) !== original.digest || !/^[a-f0-9]{64}$/.test(expectedDigest)
      || binding.observedControl.activeOperation !== null || binding.observedControl.generation >= 10000) throw new Error();
    inspect(envelope);
    if (digest(envelope) !== expectedDigest) throw new Error();
    if ((await openConfluenceCopyLedgerArchive(envelope,binding,keys)).body !== body) throw new Error();
    let saved = await store.readConfluenceCopyLedger(binding.context.operationId), replayed = saved !== null;
    if (saved === null) {
      const created = await store.createConfluenceCopyLedger(binding.context.operationId,envelope);
      if (typeof created !== 'boolean') throw new Error();
      replayed = !created;
      saved = await store.readConfluenceCopyLedger(binding.context.operationId);
    }
    if (saved !== envelope) throw new Error();
    return { digest: expectedDigest, replayed, archiveReadbackVerified: true as const, ...noAuthority };
  } catch { throw new Error('Prepared Confluence ledger preservation unresolved; retain the original candidate'); }
}

export async function preserveConfluenceCopyLedgerArchive(body: string, raw: ConfluenceCopyLedgerArchiveBinding,
  keys: RecoveryDataKeys, store: ConfluenceCopyLedgerObjects) {
  try {
    const binding = bindingSchema.parse(raw); requireLedger(body,binding);
    let envelope = await store.readConfluenceCopyLedger(binding.context.operationId), replayed = envelope !== null;
    if (envelope === null) {
      const candidate = await sealConfluenceCopyLedgerArchive(body,binding,keys);
      replayed = !(await store.createConfluenceCopyLedger(binding.context.operationId,candidate.envelope));
      envelope = await store.readConfluenceCopyLedger(binding.context.operationId);
    }
    if (envelope === null || (await openConfluenceCopyLedgerArchive(envelope,binding,keys)).body !== body) throw new Error();
    return { digest: digest(envelope), replayed, archiveReadbackVerified: true as const, ...noAuthority };
  } catch { throw new Error('Confluence ledger preservation unresolved; retry the exact original archive'); }
}
/** Expected digest/binding must come from separately authenticated publication
 * evidence. Never trust a restore's own digest as proof of freshness/authority. */
export async function readVerifiedConfluenceCopyLedgerArchive(expectedDigest: string, raw: ConfluenceCopyLedgerArchiveBinding,
  keys: RecoveryDataKeys, store: Pick<ConfluenceCopyLedgerObjects,'readConfluenceCopyLedger'>) {
  try {
    const binding = bindingSchema.parse(raw);
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error();
    const envelope = await store.readConfluenceCopyLedger(binding.context.operationId);
    if (envelope === null || digest(envelope) !== expectedDigest) throw new Error();
    return await openConfluenceCopyLedgerArchive(envelope,binding,keys);
  } catch { throw new Error('Published Confluence ledger archive is missing or invalid'); }
}
