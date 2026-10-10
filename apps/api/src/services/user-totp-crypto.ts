import { AppError } from '../utils/app-error.js';
import { openTotpEnvelope, sealTotpEnvelope, totpEnvelopeIsCurrent,
  type TotpEnvelopeV2, type TotpRealm } from './totp-secret-envelope.js';

/**
 * Charity-user authenticator secrets, sealed under a key derived from
 * JWT_SECRET. During a JWT_SECRET rotation, set the old value as
 * JWT_SECRET_PREVIOUS: authenticators keep working, each is re-sealed on its
 * next successful use or by the batch re-seal, and the previous secret can be
 * removed once none remain (see totp-secret-envelope.ts).
 */
const USER_TOTP_REALM: TotpRealm = {
  rootEnv: 'JWT_SECRET',
  label: 'charitypilot:charity-user:totp:v1',
  unavailable: () => new AppError(500, 'SECOND_FACTOR_UNAVAILABLE', 'Account sign-in security is unavailable.'),
  unreadable: () => new AppError(500, 'SECOND_FACTOR_UNREADABLE',
    'The account authenticator could not be opened. Use a saved recovery code or contact an administrator.'),
  rotatedAway: () => new AppError(500, 'SECOND_FACTOR_UNREADABLE',
    'The account authenticator could not be opened: it was set up under a signing secret that is no '
      + 'longer configured. Use a saved recovery code or contact an administrator.'),
};

export function sealUserTotpSecret(secret: string): TotpEnvelopeV2 {
  return sealTotpEnvelope(USER_TOTP_REALM, secret);
}

export function openUserTotpSecret(value: unknown): string {
  return openTotpEnvelope(USER_TOTP_REALM, value);
}

/** True when the stored secret is already sealed under the current JWT_SECRET. */
export function userTotpSecretIsCurrent(value: unknown): boolean {
  return totpEnvelopeIsCurrent(USER_TOTP_REALM, value);
}
