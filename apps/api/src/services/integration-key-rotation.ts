/**
 * Online rotation of INTEGRATION_ENCRYPTION_KEY, built on the "correct" defence
 * in ARCHITECTURE.md's rotation trap: every envelope opens with the key of its
 * own generation, so a rotation has no window in which credentials look
 * corrupt.
 *
 * The operator procedure, in order:
 *  1. Configure the new key as INTEGRATION_ENCRYPTION_KEY and the current key as
 *     INTEGRATION_ENCRYPTION_KEY_PREVIOUS, then restart. Until step 2 the app
 *     keeps sealing and opening under the previous key (rotation pending).
 *  2. `begin`: proves the previous key is the one this installation recorded,
 *     then advances the generation and records both fingerprints at once.
 *  3. `reseal`: opens each older-generation row with the retired key and
 *     re-seals it under the new one. Safe to repeat; it never touches a row
 *     that changed underneath it.
 *  4. When `status` reports no rows awaiting rotation, remove
 *     INTEGRATION_ENCRYPTION_KEY_PREVIOUS. The retired key must still be kept
 *     wherever backups that predate the rotation are kept.
 *
 * Nothing here logs, returns or stores a key or a credential; only
 * fingerprints and counts leave this module.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { decodeIntegrationKey, integrationKeyFingerprint, openIntegrationSecret,
  sealIntegrationSecret } from './integration-crypto.js';
import {
  configuredPreviousIntegrationKey,
  integrationGenerationUnavailable,
  integrationSecretContext,
  requireIntegrationSealedEnvelope,
  resolveIntegrationKeys,
} from './integration-credential.service.js';

export type IntegrationKeyRotationClient = Pick<
  PrismaClient,
  'organisationIntegration' | 'integrationCredential' | 'integrationSecretControl'
>;

export type IntegrationKeyRotationState =
  | 'NO_KEY_RECORDED'
  | 'STEADY'
  | 'ROTATION_PENDING'
  | 'RESEALING'
  | 'KEY_MISMATCH';

export type IntegrationKeyRotationStatus = {
  state: IntegrationKeyRotationState;
  generation: number;
  recordedActiveFingerprint: string | null;
  recordedRetiredFingerprint: string | null;
  configuredActiveFingerprint: string | null;
  configuredPreviousFingerprint: string | null;
  credentialsByGeneration: Record<string, number>;
  awaitingReseal: number;
};

function configuredActiveFingerprint(): string | null {
  const configured = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (typeof configured !== 'string' || configured.length === 0) return null;
  return integrationKeyFingerprint(decodeIntegrationKey(configured));
}

/** Describe where a rotation stands. Decrypts nothing. */
export async function integrationKeyRotationStatus(
  prisma: IntegrationKeyRotationClient,
): Promise<IntegrationKeyRotationStatus> {
  const control = await prisma.integrationSecretControl.findUnique({
    where: { id: 1 },
    select: { generation: true, activeKeyFingerprint: true, retiredKeyFingerprint: true },
  });
  const generation = control?.generation ?? 1;
  const recordedActive = control?.activeKeyFingerprint ?? null;
  const recordedRetired = control?.retiredKeyFingerprint ?? null;
  const configuredActive = configuredActiveFingerprint();
  const configuredPrevious = configuredPreviousIntegrationKey()?.fingerprint ?? null;
  const rows = await prisma.integrationCredential.findMany({ select: { generation: true } });
  const byGeneration: Record<string, number> = {};
  for (const row of rows) byGeneration[String(row.generation)] = (byGeneration[String(row.generation)] ?? 0) + 1;
  const awaiting = rows.filter(row => row.generation < generation).length;

  let state: IntegrationKeyRotationState;
  if (recordedActive === null) state = 'NO_KEY_RECORDED';
  else if (configuredActive === recordedActive) state = awaiting > 0 ? 'RESEALING' : 'STEADY';
  else if (configuredPrevious === recordedActive) state = 'ROTATION_PENDING';
  else state = 'KEY_MISMATCH';

  return { state, generation, recordedActiveFingerprint: recordedActive,
    recordedRetiredFingerprint: recordedRetired, configuredActiveFingerprint: configuredActive,
    configuredPreviousFingerprint: configuredPrevious, credentialsByGeneration: byGeneration,
    awaitingReseal: awaiting };
}

/**
 * Advance the key generation. Requires the new key active and the old key as
 * INTEGRATION_ENCRYPTION_KEY_PREVIOUS, the old key matching the recorded
 * fingerprint, the caller's expected generation, and no rows left from an
 * earlier rotation (only one retired key is ever held). The control row is
 * changed by one conditional update, so a concurrent begin cannot apply twice.
 */
export async function beginIntegrationKeyRotation(
  prisma: IntegrationKeyRotationClient,
  expectedGeneration: number,
  now: Date = new Date(),
): Promise<{ generation: number; activeFingerprint: string; retiredFingerprint: string; alreadyBegun: boolean }> {
  if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
    throw new AppError(400, 'INTEGRATION_ROTATION_GENERATION_REQUIRED', 'An expected current generation is required');
  }
  const newFingerprint = configuredActiveFingerprint();
  const previous = configuredPreviousIntegrationKey();
  if (!newFingerprint || !previous) {
    throw new AppError(400, 'INTEGRATION_ROTATION_KEYS_REQUIRED',
      'Configure the new key as INTEGRATION_ENCRYPTION_KEY and the current key as INTEGRATION_ENCRYPTION_KEY_PREVIOUS');
  }
  if (newFingerprint === previous.fingerprint) {
    throw new AppError(400, 'INTEGRATION_ROTATION_SAME_KEY', 'The new key must differ from the previous key');
  }
  const control = await prisma.integrationSecretControl.findUnique({
    where: { id: 1 },
    select: { generation: true, activeKeyFingerprint: true, retiredKeyFingerprint: true },
  });
  if (!control || control.activeKeyFingerprint === null) {
    throw new AppError(409, 'INTEGRATION_ROTATION_NOTHING_RECORDED',
      'No key fingerprint is recorded, so nothing has been sealed yet. Configure the new key alone instead of rotating.');
  }
  if (control.activeKeyFingerprint === newFingerprint && control.retiredKeyFingerprint === previous.fingerprint
    && control.generation === expectedGeneration + 1) {
    return { generation: control.generation, activeFingerprint: newFingerprint,
      retiredFingerprint: previous.fingerprint, alreadyBegun: true };
  }
  if (control.generation !== expectedGeneration) {
    throw new AppError(409, 'INTEGRATION_ROTATION_GENERATION_CHANGED',
      `The active generation is ${control.generation}, not the expected ${expectedGeneration}`);
  }
  if (control.activeKeyFingerprint !== previous.fingerprint) {
    throw new AppError(409, 'INTEGRATION_ROTATION_PREVIOUS_KEY_MISMATCH',
      'INTEGRATION_ENCRYPTION_KEY_PREVIOUS is not the key this installation recorded. Nothing was changed.');
  }
  const unfinished = await prisma.integrationCredential.count({
    where: { generation: { lt: control.generation } },
  });
  if (unfinished > 0) {
    throw new AppError(409, 'INTEGRATION_ROTATION_UNFINISHED',
      `${unfinished} credential(s) still await re-sealing from an earlier rotation. Finish that first.`);
  }
  const changed = await prisma.integrationSecretControl.updateMany({
    where: { id: 1, generation: expectedGeneration, activeKeyFingerprint: previous.fingerprint },
    data: { generation: expectedGeneration + 1, activeKeyFingerprint: newFingerprint,
      retiredKeyFingerprint: previous.fingerprint, rotatedAt: now },
  });
  if (changed.count !== 1) {
    throw new AppError(409, 'INTEGRATION_ROTATION_CONCURRENT_CHANGE',
      'The rotation control record changed while beginning the rotation. Nothing was changed by this call.');
  }
  return { generation: expectedGeneration + 1, activeFingerprint: newFingerprint,
    retiredFingerprint: previous.fingerprint, alreadyBegun: false };
}

/**
 * Re-seal a bounded batch of older-generation credentials under the active
 * key. Each row is opened with its own generation's key and written back only
 * if it is unchanged since it was read; a row that changed is skipped for the
 * next run. A row this deployment cannot open is reported by code, never
 * overwritten.
 */
export async function resealIntegrationCredentials(
  prisma: IntegrationKeyRotationClient,
  batchSize = 50,
): Promise<{ resealed: number; skippedChanged: number; failed: Array<{ id: string; code: string }>; remaining: number }> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new AppError(400, 'INTEGRATION_ROTATION_BATCH_INVALID', 'Batch size must be between 1 and 500');
  }
  const active = await resolveIntegrationKeys(prisma);
  const status = await integrationKeyRotationStatus(prisma);
  if (status.state !== 'RESEALING' && status.state !== 'STEADY') {
    throw new AppError(409, 'INTEGRATION_ROTATION_NOT_BEGUN',
      `Re-sealing needs a begun rotation with the new key active; the state is ${status.state}`);
  }
  const rows = await prisma.integrationCredential.findMany({
    where: { generation: { lt: active.generation } },
    select: { id: true, integrationId: true, kind: true, sealed: true, generation: true, updatedAt: true },
    orderBy: { id: 'asc' },
    take: batchSize,
  });
  let resealed = 0;
  let skippedChanged = 0;
  const failed: Array<{ id: string; code: string }> = [];
  for (const row of rows) {
    try {
      const sealed = requireIntegrationSealedEnvelope(row.sealed);
      if (sealed.generation !== row.generation) {
        throw new AppError(500, 'INTEGRATION_SECRET_GENERATION_INCONSISTENT',
          'The envelope generation differs from the row generation');
      }
      const key = active.keyForGeneration(sealed.generation);
      if (!key) throw integrationGenerationUnavailable(sealed.generation, active.generation);
      const context = await integrationSecretContext(prisma, row.integrationId, row.kind);
      const plaintext = openIntegrationSecret(sealed, key, context);
      const resealedEnvelope = sealIntegrationSecret(plaintext, active.key, active.generation, context);
      const written = await prisma.integrationCredential.updateMany({
        where: { id: row.id, generation: row.generation, updatedAt: row.updatedAt },
        data: { sealed: resealedEnvelope as unknown as Prisma.InputJsonObject, generation: resealedEnvelope.generation },
      });
      if (written.count === 1) resealed += 1;
      else skippedChanged += 1;
    } catch (error) {
      failed.push({ id: row.id, code: error instanceof AppError ? error.code : 'INTEGRATION_ROTATION_RESEAL_FAILED' });
    }
  }
  const remaining = await prisma.integrationCredential.count({
    where: { generation: { lt: active.generation } },
  });
  return { resealed, skippedChanged, failed, remaining };
}
