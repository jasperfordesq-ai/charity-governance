import { AppError } from '../utils/app-error.js';
import { openTotpEnvelope, sealTotpEnvelope, totpEnvelopeIsCurrent,
  type TotpEnvelope, type TotpRealm } from './totp-secret-envelope.js';

/**
 * Sealing and opening an operator's TOTP secret, kept apart from
 * operator-second-factor.service.ts so that it depends on nothing but node:crypto.
 *
 * The E2E harness has to seal a secret itself to enrol an operator fixture, and
 * it must use this exact code: a secret sealed with a different key or envelope
 * cannot be opened by the API, which answers 500 and reads in a test as a broken
 * product rather than a broken fixture. Importing the service to get it pulled
 * @prisma/client and fastify into the harness's type-check, which only fails in
 * CI (scripts/check-e2e-api-imports.mjs explains the trap and guards it).
 */
export type SealedTotpSecret = TotpEnvelope;

/**
 * The key the secret is sealed with, derived from the operator realm's own
 * signing secret.
 *
 * Deriving rather than adding another environment variable is deliberate. The
 * deploy already carries several keys and every additional one is another
 * thing to rotate, back up and lose; a second factor that cannot be rolled out
 * without a new secret is a second factor that does not get rolled out. HKDF
 * with a fixed label keeps the derived key separate from the signing use, so
 * the two cannot be confused even though they share a root.
 *
 * Rotating OWNER_JWT_SECRET no longer forces operators to enrol again: set the
 * old value as OWNER_JWT_SECRET_PREVIOUS until every secret has been re-sealed
 * (on next successful use, or by the batch re-seal).
 */
const OPERATOR_TOTP_REALM: TotpRealm = {
  rootEnv: 'OWNER_JWT_SECRET',
  label: 'charitypilot:operator:totp:v1',
  unavailable: () => new AppError(
    500,
    'OPERATOR_SECOND_FACTOR_UNAVAILABLE',
    'OWNER_JWT_SECRET must be set, and at least 32 characters, before a second factor can be used.',
  ),
  unreadable: () => new AppError(
    500,
    'OPERATOR_SECOND_FACTOR_UNREADABLE',
    'The stored second-factor secret could not be read.',
  ),
  failedToOpen: () => new AppError(
    500,
    'OPERATOR_SECOND_FACTOR_UNREADABLE',
    'The stored second-factor secret could not be opened. If OWNER_JWT_SECRET was changed, '
      + 'set the old value as OWNER_JWT_SECRET_PREVIOUS, or affected operators must enrol again.',
  ),
  rotatedAway: () => new AppError(
    500,
    'OPERATOR_SECOND_FACTOR_UNREADABLE',
    'The stored second-factor secret could not be opened. It was sealed under an OWNER_JWT_SECRET that is no '
      + 'longer configured: set the old value as OWNER_JWT_SECRET_PREVIOUS, or the operator must enrol again.',
  ),
};

export function sealTotpSecret(secret: string): SealedTotpSecret {
  return sealTotpEnvelope(OPERATOR_TOTP_REALM, secret);
}

export function openTotpSecret(sealed: unknown): string {
  return openTotpEnvelope(OPERATOR_TOTP_REALM, sealed);
}

/** True when the stored secret is already sealed under the current OWNER_JWT_SECRET. */
export function operatorTotpSecretIsCurrent(sealed: unknown): boolean {
  return totpEnvelopeIsCurrent(OPERATOR_TOTP_REALM, sealed);
}
