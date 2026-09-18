/**
 * The `state` parameter for the integration OAuth flow.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THIS IS THE CSRF DEFENCE FOR THE WHOLE FLOW. READ BEFORE CHANGING IT.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The callback is what attaches a Confluence site to a CharityPilot
 * organisation. An unvalidated callback therefore lets an attacker complete
 * *their* Atlassian authorisation inside a victim charity's session: every
 * governance document that charity later publishes would go to the attacker's
 * space. Nothing downstream can detect that — by the time `connectConfluence`
 * runs, the only claim about who this authorisation belongs to is the one
 * this module makes.
 *
 * So `state` is not a nonce the server happens to recognise. It is a signed
 * assertion, and the callback must verify it **before anything else**.
 *
 * No scheme is invented here. It is `apps/api/src/utils/jwt.ts`'s idiom —
 * `jsonwebtoken`, HS256, `JWT_SECRET`, a pinned issuer and audience, a short
 * `expiresIn` — with two deliberate differences:
 *
 * 1. **A distinct audience.** `charitypilot-integration-oauth-state` is not
 *    `charitypilot-web`, so a CharityPilot access token can never be replayed
 *    as a state, and a state can never be replayed as an access token. Sharing
 *    a secret between two token types is only safe when the two are told
 *    apart by something the signature covers.
 * 2. **The algorithm is pinned on verify.** `algorithms: ['HS256']` is what
 *    refuses an `alg: none` token; without it a forged, unsigned state is
 *    accepted.
 *
 * `JWT_SECRET` is read at call time rather than at module load: the route
 * module is imported by tests that set the environment themselves, and a
 * module-load read would make the import order load-bearing.
 */
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';

const STATE_ALGORITHM = 'HS256';
const STATE_ISSUER = 'charitypilot-api';
const STATE_AUDIENCE = 'charitypilot-integration-oauth-state';

/**
 * Long enough for a charity administrator to read an Atlassian consent screen
 * and pick a site; short enough that a state captured from a browser history,
 * a proxy log or an over-the-shoulder glance is worthless by the time it is
 * used. It is also the window in which the authorization code it accompanies
 * is valid at Atlassian, so a longer expiry buys nothing.
 */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** Defensive bound before the string reaches the JWT parser at all. */
const MAX_STATE_LENGTH = 4096;

export const INTEGRATION_OAUTH_STATE_INVALID_CODE = 'CONFLUENCE_OAUTH_STATE_INVALID';

export type IntegrationOAuthState = {
  organisationId: string;
  userId: string;
  provider: 'CONFLUENCE';
  /**
   * The exact `redirect_uri` the authorization URL was built with. Atlassian
   * requires the exchange to present the same value, and taking it from the
   * signed state rather than from the callback request means a caller cannot
   * steer the exchange at a redirect URI we never authorised.
   */
  redirectUri: string;
};

function stateSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('FATAL: JWT_SECRET environment variable must be set. The server will not start without it.');
  }
  return secret;
}

export function signIntegrationOAuthState(state: IntegrationOAuthState): string {
  return jwt.sign(
    {
      organisationId: state.organisationId,
      userId: state.userId,
      provider: state.provider,
      redirectUri: state.redirectUri,
      // Not consulted on the way back — there is no server-side nonce store,
      // and adding one would need a table this phase does not ship. It is here
      // so two states minted seconds apart are distinguishable to an operator
      // reading logs, and so the string is never a pure function of its
      // claims. Replay of a *valid* state by its own organisation is bounded
      // by Atlassian's single-use authorization code, which is what actually
      // makes the second attempt worthless.
      jti: randomUUID(),
    },
    stateSecret(),
    {
      algorithm: STATE_ALGORITHM,
      issuer: STATE_ISSUER,
      audience: STATE_AUDIENCE,
      expiresIn: OAUTH_STATE_TTL_SECONDS,
    },
  );
}

/**
 * Verify a state and prove it belongs to the caller.
 *
 * Signature, algorithm, issuer, audience and expiry are all checked, and then
 * — the part that actually stops the attack — the organisation the state was
 * minted for is compared against the organisation of the *authenticated*
 * request. A perfectly valid state minted by another charity is rejected here.
 *
 * Every failure is the same 400 with the same code and the same message. The
 * offending value is never echoed back, never logged, and the reasons are
 * never distinguished to the caller: a rejection oracle that says "right
 * signature, wrong organisation" is a free confirmation an attacker does not
 * need.
 */
export function verifyIntegrationOAuthState(
  raw: unknown,
  expected: { organisationId: string; provider: 'CONFLUENCE' },
): IntegrationOAuthState {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_STATE_LENGTH) {
    throw invalidState();
  }

  let decoded: unknown;
  try {
    decoded = jwt.verify(raw, stateSecret(), {
      algorithms: [STATE_ALGORITHM],
      issuer: STATE_ISSUER,
      audience: STATE_AUDIENCE,
    });
  } catch {
    // The underlying JsonWebTokenError is deliberately not attached as
    // `cause`: it can carry the offending token.
    throw invalidState();
  }

  if (!decoded || typeof decoded !== 'object') throw invalidState();
  const payload = decoded as Partial<IntegrationOAuthState>;

  if (
    typeof payload.organisationId !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.redirectUri !== 'string' ||
    payload.provider !== expected.provider ||
    payload.organisationId !== expected.organisationId
  ) {
    throw invalidState();
  }

  return {
    organisationId: payload.organisationId,
    userId: payload.userId,
    provider: payload.provider,
    redirectUri: payload.redirectUri,
  };
}

function invalidState(): AppError {
  return new AppError(
    400,
    INTEGRATION_OAUTH_STATE_INVALID_CODE,
    'This Confluence authorisation could not be verified as one this organisation started. ' +
      'Start the connection again from CharityPilot.',
  );
}
