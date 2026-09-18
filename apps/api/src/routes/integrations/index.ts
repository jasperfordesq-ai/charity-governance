/**
 * The HTTP surface of the Confluence integration: authorize, callback,
 * status, disconnect.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE LAYER BELOW BINDS BUT DOES NOT AUTHORIZE. THIS IS WHERE IT IS DONE.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * `integration-credential.service.ts` opens by saying so in as many words:
 * the AAD context is derived from the `OrganisationIntegration` row an
 * `integrationId` names, so handing it *another* charity's id yields that
 * charity's context and the decrypt succeeds. Until this file existed there
 * was no route that could be handed one, which is the only reason that was
 * survivable.
 *
 * The defence here is structural rather than remembered: **no route accepts
 * an `integrationId`, from a body, a query string or a path parameter.**
 * Every lookup goes through `findOwnConfluenceIntegration`, which keys on
 * `organisationId_provider` with the organisation taken from the
 * authenticated request. An id that was never accepted cannot be forged, and
 * a check that does not exist cannot be forgotten by the next route added
 * here.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authGuard } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/roles.js';
import {
  connectConfluence,
  disconnectConfluence,
  type ConfluenceConnectionClient,
  type ConfluenceConnectionDeps,
} from '../../services/confluence-connection.service.js';
import { decodeIntegrationKey } from '../../services/integration-crypto.js';
import { AppError, handleError } from '../../utils/errors.js';
import { sendNoContent, sendSuccess } from '../../utils/response.js';
import { signIntegrationOAuthState, verifyIntegrationOAuthState } from './oauth-state.js';

const PROVIDER = 'CONFLUENCE' as const;

const ATLASSIAN_AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';

/**
 * Where `server.ts` mounts this plugin. Exported because the `redirect_uri`
 * is built from it: the URI registered with Atlassian and the path that
 * actually answers must be the same string, and deriving one from the other
 * is how they stay that way through a future re-mount.
 */
export const INTEGRATION_ROUTES_PREFIX = '/api/v1/integrations';

/**
 * The granular Confluence scopes, plus `offline_access`.
 *
 * **`offline_access` is not optional and is not decoration.** Without it
 * Atlassian issues no refresh token at all, the access token dies within the
 * hour, and every connected charity is silently disconnected before lunchtime
 * with nothing able to renew it. `connectConfluence` refuses a connection
 * whose exchange produced no refresh token for exactly this reason; this list
 * is what stops that refusal ever being reached.
 */
export const CONFLUENCE_OAUTH_SCOPES = [
  'read:page:confluence',
  'write:page:confluence',
  'read:attachment:confluence',
  'write:attachment:confluence',
  'read:space:confluence',
  'read:content-details:confluence',
  'offline_access',
] as const;

export type IntegrationRoutesOptions = {
  /** Test seam only; production passes nothing and the service uses its own defaults. */
  confluenceDeps?: ConfluenceConnectionDeps;
};

// ── the configuration gate ──────────────────────────────────────────────────

/**
 * A refusal that is sent directly rather than thrown.
 *
 * `sendError` replaces the message and code of any >=500 response with
 * "Internal server error"/`INTERNAL_ERROR` when `NODE_ENV=production` — which
 * is right for an unexpected fault, and exactly wrong here. An appliance runs
 * with `NODE_ENV=production`, and the whole point of this gate is that the
 * operator is *told what to set*. A masked 500 would leave them no better off
 * than the failure mode the gate exists to replace.
 *
 * Sending it directly is safe because every field below is a compile-time
 * constant: no request data, no environment value, no key material and no
 * fingerprint is interpolated into any of them.
 */
type ConnectRefusal = { statusCode: number; code: string; message: string };

const MISSING_ENCRYPTION_KEY: ConnectRefusal = {
  statusCode: 503,
  code: 'INTEGRATION_ENCRYPTION_KEY_MISSING',
  message:
    'Connecting Confluence is unavailable because INTEGRATION_ENCRYPTION_KEY is not set on this ' +
    'CharityPilot server. It is the key every stored integration credential is sealed under. ' +
    'Generate one with `openssl rand -hex 32`, set it, and restart the API. Keep it backed up and ' +
    'carry it across upgrades: regenerating it later makes every stored credential unreadable.',
};

const INVALID_ENCRYPTION_KEY: ConnectRefusal = {
  statusCode: 503,
  code: 'INTEGRATION_ENCRYPTION_KEY_INVALID',
  message:
    'Connecting Confluence is unavailable because INTEGRATION_ENCRYPTION_KEY on this CharityPilot ' +
    'server does not decode to exactly 32 bytes. It must be 32 random bytes as hex ' +
    '(`openssl rand -hex 32`) or unpadded base64url. Fix the value and restart the API.',
};

const MISSING_ATLASSIAN_CLIENT: ConnectRefusal = {
  statusCode: 503,
  code: 'ATLASSIAN_OAUTH_CLIENT_NOT_CONFIGURED',
  message:
    'Connecting Confluence is unavailable because ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET ' +
    'are not both set on this CharityPilot server. Create an OAuth 2.0 (3LO) app in the Atlassian ' +
    'developer console, then set both values and restart the API.',
};

const MISSING_CALLBACK_ORIGIN: ConnectRefusal = {
  statusCode: 503,
  code: 'INTEGRATION_CALLBACK_ORIGIN_NOT_CONFIGURED',
  message:
    'Connecting Confluence is unavailable because NEXT_PUBLIC_API_URL is not set to a valid http(s) ' +
    'origin on this CharityPilot server. It is what the Atlassian OAuth callback URL is built from. ' +
    'Set it and restart the API.',
};

/**
 * Everything that must be true before an OAuth round trip may begin, checked
 * in the order an operator would want to hear about it.
 *
 * `INTEGRATION_ENCRYPTION_KEY` is first, and it is the reason this function
 * exists. Phase 1 deliberately left that key out of the appliance's boot-time
 * validation — requiring it would have failed the boot of every existing
 * appliance install on upgrade, for a key nothing read yet — and recorded the
 * trade as prose in `docs/ARCHITECTURE.md`: gate the *feature*, not the
 * *boot*. This is where that obligation comes due, and it applies on **every**
 * deployment profile, appliance included. Without it an appliance operator
 * completes an entire authorisation with Atlassian and only discovers the
 * problem when the first token store fails — after the charity has already
 * granted access.
 *
 * The key is decoded, not merely tested for presence: a key that is set but
 * malformed fails just as late and just as confusingly.
 */
function connectRefusal(): ConnectRefusal | null {
  const configuredKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (typeof configuredKey !== 'string' || configuredKey.trim().length === 0) {
    return MISSING_ENCRYPTION_KEY;
  }
  try {
    decodeIntegrationKey(configuredKey);
  } catch {
    // The thrown AppError is not forwarded: it is a 500, so its message would
    // be masked in production, which is the one thing this gate must avoid.
    return INVALID_ENCRYPTION_KEY;
  }

  if (!process.env.ATLASSIAN_CLIENT_ID || !process.env.ATLASSIAN_CLIENT_SECRET) {
    return MISSING_ATLASSIAN_CLIENT;
  }

  if (!confluenceRedirectUri()) {
    return MISSING_CALLBACK_ORIGIN;
  }

  return null;
}

function sendConnectRefusal(request: FastifyRequest, reply: FastifyReply, refusal: ConnectRefusal): FastifyReply {
  // Warn, not error: this is a deployment that has not been configured for a
  // feature, not a fault. It deliberately does not reach the error-alert
  // webhook, which would page somebody for an operator's own to-do.
  request.log.warn({ code: refusal.code }, 'Confluence connect refused: server not configured');
  return reply.status(refusal.statusCode).send({ error: refusal.message, code: refusal.code });
}

/**
 * The callback URL, derived from the API's own public origin and this
 * plugin's mount path so the value registered with Atlassian and the route
 * that answers can never drift apart.
 *
 * `NEXT_PUBLIC_API_URL` may be a comma-separated list; the first entry is the
 * canonical origin, exactly as `getPrimaryFrontendOrigin` treats
 * `FRONTEND_URL`. Returns null rather than guessing when it is absent or is
 * not an http(s) URL.
 */
function confluenceRedirectUri(): string | null {
  const configured = process.env.NEXT_PUBLIC_API_URL
    ?.split(',')
    .map((value) => value.trim())
    .find(Boolean);
  if (!configured) return null;

  let origin: string;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    origin = url.origin;
  } catch {
    return null;
  }

  return `${origin}${INTEGRATION_ROUTES_PREFIX}/confluence/callback`;
}

// ── ownership-scoped lookup ─────────────────────────────────────────────────

type OwnIntegration = {
  id: string;
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  config: unknown;
  lastError: string | null;
  connectedAt: Date | null;
};

/**
 * The only way any route in this file names an integration.
 *
 * Keyed on the `organisationId_provider` unique index with the organisation
 * taken from the authenticated request, so the `integrationId` that reaches
 * the credential layer is one this server derived, never one a caller
 * supplied. That is the structural form of the ownership check the credential
 * service's header demands; an explicit "does this row belong to me?"
 * comparison would be the weaker version, because it can be omitted.
 */
async function findOwnConfluenceIntegration(
  prisma: FastifyInstance['prisma'],
  organisationId: string,
): Promise<OwnIntegration | null> {
  const found = await prisma.organisationIntegration.findUnique({
    where: { organisationId_provider: { organisationId, provider: PROVIDER } },
    // Deliberately narrow. `refreshClaimToken`, `refreshClaimedAt`,
    // `refreshFailureCount` and `connectedById` are internal machinery and
    // never leave the server; nothing here is credential material.
    select: { id: true, status: true, config: true, lastError: true, connectedAt: true },
  });
  return (found as OwnIntegration | null) ?? null;
}

type SiteFacts = { siteUrl: string | null; siteName: string | null; siteCount: number | null };

/** `config` holds non-secret site facts only (see the schema comment). Read defensively. */
function siteFacts(config: unknown): SiteFacts {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { siteUrl: null, siteName: null, siteCount: null };
  }
  const record = config as Record<string, unknown>;
  return {
    siteUrl: typeof record.siteUrl === 'string' ? record.siteUrl : null,
    siteName: typeof record.siteName === 'string' ? record.siteName : null,
    siteCount: typeof record.siteCount === 'number' ? record.siteCount : null,
  };
}

function stringParam(query: unknown, name: string): string | undefined {
  const value = (query as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ── routes ──────────────────────────────────────────────────────────────────

export async function integrationRoutes(
  app: FastifyInstance,
  options: IntegrationRoutesOptions = {},
): Promise<void> {
  const deps = options.confluenceDeps ?? {};
  const prisma = app.prisma as ConfluenceConnectionClient;

  // Hooks rather than per-route `preHandler`, for the same reason the lookup
  // above is structural: a route added to this file later inherits both
  // guards instead of needing somebody to remember them.
  app.addHook('onRequest', authGuard);
  app.addHook('preHandler', requireAdmin);

  /**
   * Returns the authorization URL; deliberately does not redirect, so the web
   * app decides when and how to send the administrator to Atlassian.
   */
  app.get('/confluence/authorize', async (request, reply) => {
    try {
      const refusal = connectRefusal();
      if (refusal) return sendConnectRefusal(request, reply, refusal);

      // Non-null: connectRefusal() has already established both of these.
      const redirectUri = confluenceRedirectUri() as string;
      const clientId = process.env.ATLASSIAN_CLIENT_ID as string;

      const state = signIntegrationOAuthState({
        organisationId: request.user.organisationId,
        userId: request.user.userId,
        provider: PROVIDER,
        redirectUri,
      });

      const url = new URL(ATLASSIAN_AUTHORIZE_URL);
      url.searchParams.set('audience', 'api.atlassian.com');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('scope', CONFLUENCE_OAUTH_SCOPES.join(' '));
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('response_type', 'code');
      // Atlassian only issues a refresh token when consent is re-granted, so
      // a silent re-authorisation would produce a connection that cannot be
      // kept alive.
      url.searchParams.set('prompt', 'consent');

      return sendSuccess(reply, { authorizationUrl: url.toString() });
    } catch (error) {
      handleError(reply, error);
    }
  });

  /**
   * The callback.
   *
   * `state` is validated FIRST — before the configuration gate, before the
   * authorization code is even looked at, and long before anything is
   * exchanged or written. Everything after that line is allowed to assume
   * this authorisation belongs to the organisation making the request.
   */
  app.get('/confluence/callback', async (request, reply) => {
    try {
      const state = verifyIntegrationOAuthState(stringParam(request.query, 'state'), {
        organisationId: request.user.organisationId,
        provider: PROVIDER,
      });

      const refusal = connectRefusal();
      if (refusal) return sendConnectRefusal(request, reply, refusal);

      // Atlassian returns `error` instead of `code` when consent is refused.
      // Its value is attacker-controllable front-channel input, so it is
      // never echoed back or logged.
      if (stringParam(request.query, 'error')) {
        throw new AppError(
          400,
          'CONFLUENCE_OAUTH_DENIED',
          'Atlassian did not grant the authorisation. Nothing has been connected. Try again and ' +
            'approve the requested access.',
        );
      }

      const code = stringParam(request.query, 'code');
      if (!code) {
        throw new AppError(
          400,
          'CONFLUENCE_OAUTH_CODE_MISSING',
          'Atlassian returned no authorization code. Start the connection again from CharityPilot.',
        );
      }

      const { siteUrl } = await connectConfluence(
        prisma,
        {
          organisationId: request.user.organisationId,
          userId: request.user.userId,
          code,
          // From the signed state, never from the request.
          redirectUri: state.redirectUri,
        },
        deps,
      );

      // The tokens stay behind the credential boundary. Only the site the
      // charity just connected comes back.
      return sendSuccess(reply, { provider: PROVIDER, status: 'CONNECTED', siteUrl });
    } catch (error) {
      // Errors from `atlassian-oauth.ts` arrive with their own codes —
      // including the 409 `ATLASSIAN_OAUTH_RECONNECT_REQUIRED` and
      // `ATLASSIAN_OAUTH_RESOURCES_RECONNECT_REQUIRED`, which exist so a stale
      // Atlassian credential never reaches the web client's global 401
      // interceptor and logs the charity's user out of CharityPilot. They are
      // propagated unchanged: nothing here rewrites a status or a code, so a
      // client that branches on the code (as it must — 409 is already spoken
      // for by TENANT_LIFECYCLE_CONFLICT elsewhere in the API) sees exactly
      // what the OAuth module meant.
      handleError(reply, error);
    }
  });

  /**
   * Connection facts only. No token, no envelope, no expiry of a token, and
   * no fingerprint of a key — a fingerprint is safe to log but is still a
   * derived property of secret material and has no business on a tenant-facing
   * response.
   */
  app.get('/confluence/status', async (request, reply) => {
    try {
      const integration = await findOwnConfluenceIntegration(app.prisma, request.user.organisationId);

      if (!integration) {
        return sendSuccess(reply, {
          provider: PROVIDER,
          status: 'NOT_CONNECTED',
          siteUrl: null,
          siteName: null,
          siteCount: null,
          connectedAt: null,
          lastError: null,
        });
      }

      const facts = siteFacts(integration.config);
      return sendSuccess(reply, {
        provider: PROVIDER,
        status: integration.status,
        siteUrl: facts.siteUrl,
        siteName: facts.siteName,
        siteCount: facts.siteCount,
        connectedAt: integration.connectedAt ? new Date(integration.connectedAt).toISOString() : null,
        // Only ever one of the two fixed reasons written by
        // confluence-connection.service.ts; Atlassian's own error text is
        // deliberately never stored there.
        lastError: integration.lastError,
      });
    } catch (error) {
      handleError(reply, error);
    }
  });

  app.delete('/confluence', async (request, reply) => {
    try {
      const integration = await findOwnConfluenceIntegration(app.prisma, request.user.organisationId);
      if (!integration) {
        throw new AppError(
          404,
          'CONFLUENCE_NOT_CONNECTED',
          'This organisation has no Confluence connection to disconnect.',
        );
      }

      // Not gated on the encryption key: revoking access must keep working on
      // a server that has lost or never had it. `disconnectConfluence` deletes
      // sealed envelopes without opening any.
      await disconnectConfluence(prisma, { integrationId: integration.id });
      return sendNoContent(reply);
    } catch (error) {
      handleError(reply, error);
    }
  });
}
