/**
 * Sealed storage for integration credentials (OAuth refresh tokens and the
 * like), bound to their owning organisation via the AAD context in
 * `integration-crypto.ts`.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THIS MODULE BINDS. IT DOES NOT AUTHORIZE. READ THIS BEFORE ADDING A ROUTE.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * What the binding guarantees: a stored envelope cannot be decrypted under
 * any identity other than the one it was sealed for. A ciphertext row copied
 * from one charity's credential into another's — by a bug, a bad backfill, or
 * direct database write access — will not open.
 *
 * What it does NOT guarantee, and what every caller therefore still owes:
 *
 *     CALLERS MUST INDEPENDENTLY PROVE THAT THE REQUESTING ORGANISATION OWNS
 *     THE `integrationId` THEY PASS. NOTHING IN THIS MODULE CHECKS THAT.
 *
 * The AAD context is derived from the `OrganisationIntegration` row the
 * credential actually hangs off, looked up by `id` alone. That is deliberate
 * and correct — see `secretContextForIntegration` — but it means that when a
 * caller passes *another charity's* `integrationId`, the context is derived
 * from that charity's own row, so the decrypt succeeds and their token is
 * handed back. Tenant isolation is a route/authorization-layer obligation and
 * this layer cannot discharge it: scope the lookup that produced the
 * `integrationId` to the authenticated organisation, or verify ownership
 * explicitly, before calling anything here.
 *
 * There is deliberately no `organisationId` parameter that feeds the context.
 * Accepting one would re-create exactly the vulnerability the binding exists
 * to prevent: one wrong argument and an envelope is sealed under — or opened
 * against — an identity that is not its owner's.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import {
  decodeIntegrationKey,
  integrationKeyFingerprint,
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

/**
 * What the *store* path needs on top of the delegates: the ability to start a
 * transaction.
 *
 * `IntegrationCredentialClient` deliberately admits a `$transaction` client,
 * which is right for reads and counts but leaves the store path unable to make
 * its two writes atomic — and a sealed envelope committed without the
 * fingerprint that describes it is the one state this module must never leave
 * behind (see `storeIntegrationCredential`). So the store path asks for the
 * root client, and says so in its type instead of hoping.
 *
 * The callback is typed against `IntegrationCredentialClient`, so everything
 * inside the transaction is still restricted to the three delegates and cannot
 * open a nested one.
 */
export type IntegrationCredentialWriteClient = IntegrationCredentialClient & {
  $transaction<T>(run: (tx: IntegrationCredentialClient) => Promise<T>): Promise<T>;
};

export type StoreIntegrationCredentialInput = {
  integrationId: string;
  kind: string;
  plaintext: string;
  /**
   * Omitting this on a re-store **clears** any expiry the previous credential
   * had, rather than preserving it. A re-store is a fresh credential — the old
   * expiry described a token that no longer exists, and carrying it over would
   * attach a stale deadline to a new secret. Pinned by test: "re-storing a
   * credential without an expiry clears the previous expiry".
   */
  expiresAt?: Date | null;
};

export type LoadIntegrationCredentialInput = {
  integrationId: string;
  kind: string;
};

/**
 * The key this deployment is configured with, resolved together with the
 * rotation-control state it has to agree with.
 */
type ActiveIntegrationKey = {
  key: Buffer;
  /** Safe to log or surface in an error. The key itself is not. */
  fingerprint: string;
  /** The generation new envelopes seal under. */
  generation: number;
  /** True when this installation has never recorded a key fingerprint. */
  fingerprintUnrecorded: boolean;
};

/**
 * Resolve the key the deployment is currently sealing under, and refuse to
 * use it if it disagrees with the fingerprint this installation recorded.
 *
 * The environment is re-read on every call rather than cached at import time:
 * production validates it at boot (see utils/env.ts), and re-reading keeps the
 * tests able to drive it without a module-level reset hatch.
 *
 * The fingerprint comparison is the difference between two failures that used
 * to be indistinguishable. A correctly-sized key from the wrong environment
 * (or a secret rotated without re-sealing) previously failed inside AES-GCM
 * authentication and surfaced as INTEGRATION_SECRET_UNREADABLE — the same code
 * a genuinely corrupted row produces, for every charity at once. An operator
 * reading "every credential is corrupt" would reasonably ask charities to
 * reconnect, and `storeIntegrationCredential` upserts: that would overwrite
 * envelopes that were perfectly recoverable under the right key. Checking here
 * — where the key is read, so both store and load benefit — means a wrong key
 * is named as a wrong key, and the store path refuses before it can destroy
 * anything.
 *
 * The generation is read from the same row: the single
 * `IntegrationSecretControl` row (`id: 1`); a deployment that has never
 * rotated has no row yet and is generation 1 by definition.
 */
async function activeIntegrationKey(
  prisma: IntegrationCredentialClient,
): Promise<ActiveIntegrationKey> {
  const configured = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (typeof configured !== 'string' || configured.length === 0) {
    throw new AppError(
      500,
      'INTEGRATION_KEY_MISSING',
      'INTEGRATION_ENCRYPTION_KEY is not configured',
    );
  }

  const key = decodeIntegrationKey(configured);
  const fingerprint = integrationKeyFingerprint(key);

  const control = await prisma.integrationSecretControl.findUnique({
    where: { id: 1 },
    select: { generation: true, activeKeyFingerprint: true },
  });
  const recorded = control?.activeKeyFingerprint ?? null;

  // A null fingerprint is the normal starting state of an installation that
  // has never recorded one, not an error: it means "nothing to disagree with
  // yet", so the check stands down rather than locking everyone out.
  if (recorded !== null && recorded !== fingerprint) {
    throw new AppError(
      500,
      'INTEGRATION_KEY_MISMATCH',
      'INTEGRATION_ENCRYPTION_KEY is not the key this installation sealed its ' +
        `integration credentials under (configured key fingerprint ${fingerprint}, ` +
        `recorded ${recorded}). The stored credentials are intact and are not corrupt: ` +
        'restore the correct key. Do NOT ask organisations to reconnect — re-storing ' +
        'credentials would overwrite recoverable envelopes irreversibly.',
    );
  }

  return {
    key,
    fingerprint,
    generation: control?.generation ?? 1,
    fingerprintUnrecorded: recorded === null,
  };
}

/**
 * Record the fingerprint of the key an installation is actually sealing
 * under, the first time it successfully seals anything.
 *
 * Chosen over leaving the column null until some future rotation tool writes
 * it: nothing writes it today, so a dormant column would make the mismatch
 * check above permanently inert, and the wrong-key diagnostic would never
 * fire on any existing installation. Recording on the first *successful*
 * store is also the moment the claim is definitionally true — the key just
 * sealed the only envelope that exists, so it is by construction the key
 * those envelopes open under.
 *
 * **What actually stops this overwriting an existing fingerprint is the
 * caller, not this function.** The `update` branch below sets the column
 * unconditionally; the only reason it is never reached with a fingerprint
 * already present is that `storeIntegrationCredential` calls this at all only
 * when `activeIntegrationKey` read the column as null earlier in the same
 * call. That is a time-of-check/time-of-use gap, and it is deliberately left
 * as one: closing it properly needs a conditional update plus a create whose
 * unique violation would abort the surrounding transaction — and so roll back
 * the credential write — to defend against a race whose only losing case is
 * already lost. Two concurrent first stores under the *same* key write the
 * same value and the gap is invisible; under two *different* keys the
 * deployment is already broken in a way no write order could rescue, and the
 * mismatch check in `activeIntegrationKey` is what names it. Rotation tooling
 * remains the sole intended owner of *changing* a recorded fingerprint, but
 * that is a convention here, not an invariant this statement enforces.
 *
 * The fingerprint is a domain-separated hash and is safe to persist and log.
 * The key material itself never reaches this function.
 */
async function recordActiveKeyFingerprint(
  prisma: IntegrationCredentialClient,
  fingerprint: string,
  generation: number,
): Promise<void> {
  await prisma.integrationSecretControl.upsert({
    where: { id: 1 },
    create: { id: 1, generation, activeKeyFingerprint: fingerprint },
    update: { activeKeyFingerprint: fingerprint },
  });
}

/**
 * Narrow the stored JSON column to an envelope before handing it to the
 * crypto boundary. Without this, a malformed row (`sealed: null`, a string, an
 * array, a half-written object) escapes the module's error taxonomy as a raw
 * TypeError — the one untyped 500 in this path. The schema declares the column
 * non-nullable, so this is defence against a bad backfill or direct database
 * write, not an expected shape.
 *
 * Deliberately distinct from INTEGRATION_SECRET_UNREADABLE: that code means
 * "an envelope that would not authenticate", this one means "not an envelope
 * at all", and the two call for different investigations. The offending value
 * is never interpolated into the message.
 */
function requireSealedEnvelope(sealed: unknown): SealedSecret {
  const candidate = sealed as Partial<SealedSecret> | null;

  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    Array.isArray(candidate) ||
    typeof candidate.generation !== 'number' ||
    typeof candidate.iv !== 'string' ||
    typeof candidate.tag !== 'string' ||
    typeof candidate.ciphertext !== 'string'
  ) {
    throw new AppError(
      500,
      'INTEGRATION_SECRET_MALFORMED',
      'Stored integration credential is not a sealed envelope.',
    );
  }

  return candidate as SealedSecret;
}

/**
 * Derive the AAD context from the row the credential actually hangs off —
 * never from the caller. `organisationId` and `provider` live on
 * `OrganisationIntegration`; only `kind` is the caller's, and it is the same
 * value used to address the credential row, so it cannot disagree with where
 * the envelope is stored. A caller-supplied organisation would make the
 * binding worthless: one wrong argument and the envelope is sealed under an
 * identity that isn't its owner's. There is deliberately no override.
 *
 * Note what this does and does not do — see the boundary statement at the top
 * of this file. The lookup is by `integrationId` alone and is *not* scoped to
 * a requesting organisation, so it authenticates where an envelope may live;
 * it does not authorize who may ask for it.
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
 *
 * **The credential write and the bootstrap fingerprint write are one
 * transaction.** They describe each other: the fingerprint's claim is "the key
 * that sealed the envelopes this installation holds", and the envelope's
 * safety net is the fingerprint. Written separately, a process that died — or
 * a control write that failed — between them would leave the installation
 * holding a sealed envelope with no recorded fingerprint, which makes the
 * mismatch check in `activeIntegrationKey` permanently inert for exactly the
 * installation that has just acquired something to lose. A later store under a
 * wrong key would then record the *wrong* fingerprint and upsert over the
 * recoverable envelope: the irreversible loss the check exists to prevent,
 * narrowed to a crash window but not eliminated. So the window is closed
 * rather than narrowed.
 *
 * The fingerprint is still recorded *after* the credential write within that
 * transaction, because "first successful store" means the envelope this
 * fingerprint describes actually exists — and inside one transaction the
 * ordering is now a readability choice rather than a durability one.
 */
export async function storeIntegrationCredential(
  prisma: IntegrationCredentialWriteClient,
  { integrationId, kind, plaintext, expiresAt }: StoreIntegrationCredentialInput,
): Promise<void> {
  const context = await secretContextForIntegration(prisma, integrationId, kind);
  const { key, fingerprint, generation, fingerprintUnrecorded } = await activeIntegrationKey(prisma);

  const sealed = sealIntegrationSecret(plaintext, key, generation, context);
  const sealedJson = sealed as unknown as Prisma.InputJsonObject;

  await prisma.$transaction(async (tx) => {
    await tx.integrationCredential.upsert({
      where: { integrationId_kind: { integrationId, kind } },
      create: {
        integrationId,
        kind,
        sealed: sealedJson,
        // Read back off the envelope rather than from the local `generation`, so
        // the column is definitionally a mirror of what was sealed and not a
        // second derivation that could drift from it. Rotation scans the column
        // to find stale rows without opening a single one.
        generation: sealed.generation,
        expiresAt: expiresAt ?? null,
      },
      update: {
        sealed: sealedJson,
        generation: sealed.generation,
        // Clears a previously stored expiry when the caller supplies none; see
        // StoreIntegrationCredentialInput.
        expiresAt: expiresAt ?? null,
      },
    });

    if (fingerprintUnrecorded) {
      await recordActiveKeyFingerprint(tx, fingerprint, sealed.generation);
    }
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

  const { key } = await activeIntegrationKey(prisma);
  return openIntegrationSecret(requireSealedEnvelope(credential.sealed), key, context);
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
