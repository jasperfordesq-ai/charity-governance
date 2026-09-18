import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import {
  decodeIntegrationKey,
  openIntegrationSecret,
  sealIntegrationSecret,
  type SealedSecret,
  type SecretContext,
} from './integration-crypto.js';

/**
 * Only the delegates this service touches, so a `$transaction` client is just
 * as acceptable as the root client. Deliberately structural: nothing here
 * needs the full PrismaClient surface.
 */
export type IntegrationCredentialClient = Pick<
  PrismaClient,
  'organisationIntegration' | 'integrationCredential' | 'integrationSecretControl'
>;

export type StoreIntegrationCredentialInput = {
  integrationId: string;
  kind: string;
  plaintext: string;
  expiresAt?: Date | null;
};

export type LoadIntegrationCredentialInput = {
  integrationId: string;
  kind: string;
};

/**
 * The key the deployment is currently sealing under. Read from the
 * environment on every call rather than cached at import time: production
 * validates it at boot (see utils/env.ts), and re-reading keeps the tests
 * able to drive it without a module-level reset hatch.
 */
function activeIntegrationKey(): Buffer {
  const configured = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (typeof configured !== 'string' || configured.length === 0) {
    throw new AppError(
      500,
      'INTEGRATION_KEY_MISSING',
      'INTEGRATION_ENCRYPTION_KEY is not configured',
    );
  }
  return decodeIntegrationKey(configured);
}

/**
 * The generation new envelopes are sealed under. Lives in the single
 * `IntegrationSecretControl` row (`id: 1`); a deployment that has never
 * rotated has no row yet and is generation 1 by definition.
 */
async function activeIntegrationGeneration(prisma: IntegrationCredentialClient): Promise<number> {
  const control = await prisma.integrationSecretControl.findUnique({
    where: { id: 1 },
    select: { generation: true },
  });
  return control?.generation ?? 1;
}

/**
 * Derive the AAD context from the row the credential actually hangs off —
 * never from the caller. `organisationId` and `provider` live on
 * `OrganisationIntegration`; only `kind` is the caller's, and it is the same
 * value used to address the credential row, so it cannot disagree with where
 * the envelope is stored. A caller-supplied organisation would make the
 * binding worthless: one wrong argument and the envelope is sealed under an
 * identity that isn't its owner's. There is deliberately no override.
 */
async function secretContextForIntegration(
  prisma: IntegrationCredentialClient,
  integrationId: string,
  kind: string,
): Promise<SecretContext> {
  const integration = await prisma.organisationIntegration.findUnique({
    where: { id: integrationId },
    select: { organisationId: true, provider: true },
  });

  if (!integration) {
    throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'Integration not found');
  }

  return {
    organisationId: integration.organisationId,
    provider: integration.provider,
    kind,
  };
}

/**
 * Seal `plaintext` and persist it against the integration. The plaintext
 * never leaves this function: it goes straight into the envelope and the
 * envelope is what is written.
 */
export async function storeIntegrationCredential(
  prisma: IntegrationCredentialClient,
  { integrationId, kind, plaintext, expiresAt }: StoreIntegrationCredentialInput,
): Promise<void> {
  const context = await secretContextForIntegration(prisma, integrationId, kind);
  const key = activeIntegrationKey();
  const generation = await activeIntegrationGeneration(prisma);

  const sealed = sealIntegrationSecret(plaintext, key, generation, context);
  // `generation` is stored as a column as well as inside the envelope so a
  // rotation can find stale rows without opening a single one.
  const sealedJson = sealed as unknown as Prisma.InputJsonObject;

  await prisma.integrationCredential.upsert({
    where: { integrationId_kind: { integrationId, kind } },
    create: {
      integrationId,
      kind,
      sealed: sealedJson,
      generation,
      expiresAt: expiresAt ?? null,
    },
    update: {
      sealed: sealedJson,
      generation,
      expiresAt: expiresAt ?? null,
    },
  });
}

/**
 * Open the stored envelope back to the secret, or `null` when the charity has
 * no credential of that kind. A stored row that will not open is an error,
 * not a `null`: silently treating an unreadable credential as absent would
 * hide both tampering and a wrong key behind a re-authentication prompt.
 */
export async function loadIntegrationCredential(
  prisma: IntegrationCredentialClient,
  { integrationId, kind }: LoadIntegrationCredentialInput,
): Promise<string | null> {
  const context = await secretContextForIntegration(prisma, integrationId, kind);

  const credential = await prisma.integrationCredential.findUnique({
    where: { integrationId_kind: { integrationId, kind } },
    select: { sealed: true },
  });
  if (!credential) return null;

  const key = activeIntegrationKey();
  return openIntegrationSecret(credential.sealed as unknown as SealedSecret, key, context);
}

/**
 * How many stored credentials are still sealed under a superseded key
 * generation. Counts on the denormalised column, so nothing is decrypted and
 * no plaintext is materialised to answer the question.
 */
export async function countCredentialsAwaitingRotation(
  prisma: IntegrationCredentialClient,
  activeGeneration: number,
): Promise<number> {
  return prisma.integrationCredential.count({
    where: { generation: { lt: activeGeneration } },
  });
}
