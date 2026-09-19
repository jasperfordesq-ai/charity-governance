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
import { getPrimaryFrontendOrigin } from '../../utils/frontend-origin.js';
import { sendNoContent, sendSuccess } from '../../utils/response.js';
import { signIntegrationOAuthState, verifyIntegrationOAuthState } from './oauth-state.js';

const PROVIDER = 'CONFLUENCE' as const;

const ATLASSIAN_AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';

/**
 * Where `server.ts` mounts this plugin. Exported because the retired GET
 * callback still answers underneath it, and because a caller that needs to
 * name this API's own integration paths should derive them rather than
 * retype them.
 */
export const INTEGRATION_ROUTES_PREFIX = '/api/v1/integrations';

/**
 * The path of the **web app** page that Atlassian sends the administrator
 * back to, and therefore the path half of the `redirect_uri` registered with
 * Atlassian.
 *
 * It is a page and not this API for one reason, and it is not an edge case:
 * the access-token cookie lives 15 minutes counted from login or the last
 * refresh, **not** from the moment Connect was clicked, and the
 * administrator then spends unbounded time on Atlassian's consent screen.
 * They routinely come back with a dead cookie — at which point `authGuard`
 * would answer a raw JSON 401 in a browser tab, and **the authorization code
 * in that URL is single-use and already spent**, so retrying fails
 * identically. A page can renew the session *before* spending the code; a
 * bare API redirect cannot. `docs/ARCHITECTURE.md`, "The callback is
 * cookie-authenticated, and the session can expire mid-flow", is the long
 * form.
 *
 * `apps/web/src/app/(dashboard)/integrations/confluence/callback/page.tsx`
 * serves it — `(dashboard)` is a Next route group and contributes no path
 * segment.
 *
 * **Atlassian matches `redirect_uri` byte for byte.** This constant, the
 * page's route, and the callback URL registered in the Atlassian developer
 * console are one string in three places; changing any of them alone breaks
 * every connection attempt with `invalid_grant`.
 */
export const CONFLUENCE_CALLBACK_PATH = '/integrations/confluence/callback';

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

/**
 * What an administrator is told **before** they authorise, not after.
 *
 * Every line here is a limit on a data subject's erasure request, and the
 * reason it sits on the *authorize* response rather than in a help page is
 * that a footnote nobody read is not a disclosure. `docs/ARCHITECTURE.md`,
 * "What document erasure can and cannot prove", is the long form; this is the
 * short form, and the two must not drift.
 *
 * **Do not soften any of it.** Each sentence was written against something the
 * platform genuinely cannot do:
 *
 * - Purge needs a higher permission than delete (space *manage/content* for a
 *   page, *administer space* for an attachment), so a connected site may be
 *   able to delete and unable to purge. That is an ordinary outcome.
 * - Between delete and purge, and after a refused purge, the content is in the
 *   charity's own trash, restorable by the charity's own administrators.
 * - The erasure proof covers the page; an attachment CharityPilot did not
 *   record is never enumerated.
 * - Disconnecting deletes CharityPilot's copy of the credentials — provable —
 *   and *attempts* a withdrawal at an endpoint Atlassian does not document.
 *   It must never be phrased as "we revoked your access", and the 90-day
 *   expiry is Atlassian's documented behaviour, not a CharityPilot guarantee.
 *
 * Nothing here states where a document authoritative in Confluence is
 * *resident*: that turns on an unresolved question for the owner (Open
 * Question 1 of the storage spec), and a residency claim that turns out wrong
 * is worse than none. The disclaimer below is true either way it is ruled.
 *
 * **It goes on `authorize` and nowhere else.** `status` is a keys-allow-listed
 * connection report guarded by a substring test that forbids the word "refresh"
 * ever appearing in it, because no token material may reach a tenant-facing
 * connection report. This prose names a refresh token, so carrying it there
 * would mean loosening that guard to let prose through. Showing the limits one
 * route earlier costs nothing; weakening a leak guard to repeat them costs a
 * real defence.
 *
 * The copy is pinned by tests in `integrations-route.test.ts`, deliberately:
 * this is the one place a reassuring edit would cost a charity its answer to a
 * regulator.
 */
export const CONFLUENCE_CONNECT_DISCLOSURE = Object.freeze({
  stage: 'alpha' as const,
  headline:
    'Confluence is an alpha integration. Read these limits before you connect — they change what ' +
    'CharityPilot can promise a data subject who asks you to erase their data.',
  erasure: Object.freeze([
    'Erasure from your Confluence site is best-effort, and it is bounded by permissions you ' +
      'control, not permissions CharityPilot holds.',
    'CharityPilot deletes and then permanently purges the page and the attachments it recorded, ' +
      'and proves the erasure by reading the page back and requiring a 404.',
    'Purging needs a higher permission than deleting: the space manage/content permission for a ' +
      'page, and the administer space permission for an attachment. If the connection you grant ' +
      'cannot purge, CharityPilot reports the erasure as failed and needing a person with those ' +
      'rights; it does not quietly report success.',
    'Between the delete and the purge, and after a purge your site refuses, the content sits in ' +
      "your own Confluence trash and your own administrators can restore it. CharityPilot cannot " +
      'prevent that.',
    'The proof covers the page. An attachment CharityPilot did not record is never looked for, so ' +
      'the proof is only as complete as what CharityPilot published.',
    'Content in your Confluence site is held wherever Atlassian hosts that site, which your own ' +
      'administrators choose. CharityPilot makes no data-residency guarantee for it.',
  ] as const),
  disconnecting: Object.freeze([
    'Disconnecting deletes CharityPilot’s copy of your Confluence credentials. That part is ' +
      'complete and verifiable.',
    'CharityPilot also attempts to withdraw the authorisation at Atlassian, but Atlassian ' +
      'documents no way for an app to do this, so the attempt may silently do nothing. ' +
      'CharityPilot does not claim to have revoked your access.',
    'Atlassian documents that an unused refresh token expires after 90 days. That is Atlassian’s ' +
      'behaviour and not a CharityPilot guarantee — they can change it without CharityPilot ' +
      'noticing.',
    'The only guaranteed way to withdraw the authorisation is yours to take: remove CharityPilot ' +
      'in your Atlassian account’s connected-apps settings.',
  ] as const),
  reference: 'docs/ARCHITECTURE.md — "What document erasure can and cannot prove"',
});

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
    'Connecting Confluence is unavailable because FRONTEND_URL is not set to a valid http(s) ' +
    'origin on this CharityPilot server. It is the web origin the Atlassian OAuth callback URL is ' +
    'built from. Set it and restart the API.',
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
 * The callback URL: the **web** origin plus `CONFLUENCE_CALLBACK_PATH`.
 *
 * The origin comes from `getPrimaryFrontendOrigin()` — `FRONTEND_URL`, the
 * variable the CORS allow-list, the billing return URLs and every emailed
 * link already read. Deliberately **not** a second `WEB_ORIGIN`/`APP_ORIGIN`
 * of its own: two variables that must agree are two variables that will
 * drift, and a `redirect_uri` that drifts from the registered one fails every
 * connection at the last step, after the charity has already granted access.
 *
 * Presence is tested on the raw variable rather than on the helper's answer,
 * because `getPrimaryFrontendOrigin()` falls back to `http://localhost:3000`
 * when nothing is set. That fallback is right for a development email link
 * and wrong here: it would send a production administrator to their own
 * laptop and tell nobody. Returning null instead makes `connectRefusal()`
 * name the variable to set.
 *
 * Exported so a test can assert what gets registered without going through a
 * route.
 */
export function confluenceRedirectUri(): string | null {
  if (!process.env.FRONTEND_URL?.trim()) return null;

  try {
    // `getPrimaryFrontendOrigin` already takes the first entry of a
    // comma-separated list and strips trailing slashes; `url.origin` drops
    // any path, so what is registered stays a bare origin plus this path.
    const url = new URL(getPrimaryFrontendOrigin());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}${CONFLUENCE_CALLBACK_PATH}`;
  } catch {
    return null;
  }
}

// ── the retired GET callback ────────────────────────────────────────────────

/**
 * What the old callback URL answers now.
 *
 * A deployment whose Atlassian app is still registered against
 * `{API}/api/v1/integrations/confluence/callback` keeps sending
 * administrators here, and they arrive having just granted access. A 404
 * tells them nothing and tells the operator nothing; this names the change
 * and the exact URL to register instead, which is the only thing standing
 * between a stale registration and a silent, repeating failure.
 *
 * **It answers without a session, deliberately.** The expired-cookie 401 in
 * a browser tab is the failure this whole change exists to remove; making
 * the explanation itself require a live session would reproduce it for the
 * one person who most needs to read it. Safe because the handler reads
 * nothing from the request — no query string, no body, no user — and sends
 * only this prose plus a URL derived from the server's own `FRONTEND_URL`.
 *
 * 410 rather than 404 or 400: the resource is gone on purpose, and the
 * status says so to anything reading statuses rather than prose. It is below
 * 500, so `sendError`'s production masking never reaches it and the operator
 * keeps the message.
 *
 * The prose is pinned by `integrations-route.test.ts`.
 */
const RETIRED_GET_CALLBACK = Object.freeze({
  statusCode: 410,
  code: 'CONFLUENCE_CALLBACK_MOVED',
  message:
    'This Confluence OAuth callback URL has been retired. The callback is now a page in the ' +
    'CharityPilot web app, which renews the administrator’s session before spending the ' +
    'single-use authorization code, and the code and state are sent to this API in a POST body ' +
    'rather than a query string. Nothing has been connected by this request. To fix it, ' +
    're-register the callback URL of your Atlassian OAuth 2.0 (3LO) app at ' +
    'https://developer.atlassian.com/console/myapps/ as exactly the URL in `callbackUrl` below — ' +
    'Atlassian matches it byte for byte — and start the connection again from CharityPilot.',
});

/**
 * The URL to re-register. When `FRONTEND_URL` is not configured there is no
 * origin to name, so the answer says which variable supplies it rather than
 * inventing one — the same operator also gets the 503 that names it.
 */
function retiredGetCallbackUrl(): string {
  return confluenceRedirectUri() ?? `{FRONTEND_URL}${CONFLUENCE_CALLBACK_PATH}`;
}

/**
 * The route-level opt-out from this plugin's two guards. Declaring it is the
 * only way a route in this file answers without a session, and a route that
 * declares it must read nothing from the request.
 */
const UNAUTHENTICATED_ROUTE = Object.freeze({ integrationAuth: 'none' as const });

function answersWithoutASession(request: FastifyRequest): boolean {
  const config = request.routeOptions?.config as { integrationAuth?: string } | undefined;
  return config?.integrationAuth === 'none';
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

/**
 * A non-empty string field of a JSON request body.
 *
 * The callback reads `code`, `state` and `error` from the **body** and never
 * from the query string. They are secrets: a query string reaches access
 * logs, `Referer` headers and browser history, and Phase 2 caught Caddy's
 * *error* logger writing live authorization codes to stderr on a 502
 * (`.superpowers/sdd/2026-09-18-confluence-oauth-phase-2/final-fix-report.md`).
 * `redactSensitiveQueryParams` censors CharityPilot's own request log, but it
 * cannot reach a proxy's. Moving the values out of the URL removes the
 * surface instead of re-filtering it. Nothing in this API logs a request
 * body: `serializeRequestForLog` mirrors Fastify's `req` serializer, which
 * carries the method, URL, host and peer and no body, and
 * `buildErrorAlertPayload` carries none either.
 *
 * Reads defensively: a body may be absent, null, an array or a non-object.
 */
function bodyParam(body: unknown, name: string): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>)[name];
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
  //
  // The single exception is opt-*out*, declared on the route itself and
  // visible from the route: `config: UNAUTHENTICATED_ROUTE`. A new route that
  // says nothing is still guarded, so forgetting remains impossible; only
  // writing the words unguards anything.
  app.addHook('onRequest', async (request, reply) => {
    if (answersWithoutASession(request)) return;
    await authGuard(request, reply);
  });
  app.addHook('preHandler', async (request, reply) => {
    if (answersWithoutASession(request)) return;
    await requireAdmin(request, reply);
  });

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

      // The disclosure travels with the authorization URL rather than sitting
      // in a help page, because this response *is* the moment before
      // connecting: whatever the web app does with the URL, it has been handed
      // the limits at the same time and cannot show one without the other.
      return sendSuccess(reply, {
        authorizationUrl: url.toString(),
        disclosure: CONFLUENCE_CONNECT_DISCLOSURE,
      });
    } catch (error) {
      handleError(reply, error);
    }
  });

  /**
   * The old callback URL. Kept, and made to explain itself — see
   * `RETIRED_GET_CALLBACK`. It reads nothing from the request, which is what
   * makes answering it without a session safe.
   */
  app.get('/confluence/callback', { config: UNAUTHENTICATED_ROUTE }, async (request, reply) => {
    // Warn rather than error: a stale registration is an operator's to-do,
    // not a fault, and this must not page anybody. No request data is logged
    // — the URL that carried it is censored by `redactSensitiveQueryParams`,
    // and nothing here adds to it.
    request.log.warn(
      { code: RETIRED_GET_CALLBACK.code },
      'A Confluence OAuth callback arrived at the retired API URL; the Atlassian app still needs ' +
        'its callback URL re-registered against the web app.',
    );
    return reply.status(RETIRED_GET_CALLBACK.statusCode).send({
      error: RETIRED_GET_CALLBACK.message,
      code: RETIRED_GET_CALLBACK.code,
      callbackUrl: retiredGetCallbackUrl(),
    });
  });

  /**
   * The callback.
   *
   * A POST, because `code` and `state` arrive in the body: see `bodyParam`
   * for why they may not be in a URL. The web page at
   * `CONFLUENCE_CALLBACK_PATH` is what calls it, and it renews the session
   * before doing so — which is the whole reason the callback moved.
   *
   * `state` is validated FIRST — before the configuration gate, before the
   * authorization code is even looked at, and long before anything is
   * exchanged or written. Everything after that line is allowed to assume
   * this authorisation belongs to the organisation making the request.
   */
  app.post('/confluence/callback', async (request, reply) => {
    try {
      const state = verifyIntegrationOAuthState(bodyParam(request.body, 'state'), {
        organisationId: request.user.organisationId,
        provider: PROVIDER,
      });

      const refusal = connectRefusal();
      if (refusal) return sendConnectRefusal(request, reply, refusal);

      // Atlassian returns `error` instead of `code` when consent is refused.
      // Its value is attacker-controllable front-channel input, so it is
      // never echoed back or logged.
      if (bodyParam(request.body, 'error')) {
        throw new AppError(
          400,
          'CONFLUENCE_OAUTH_DENIED',
          'Atlassian did not grant the authorisation. Nothing has been connected. Try again and ' +
            'approve the requested access.',
        );
      }

      const code = bodyParam(request.body, 'code');
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

      // Not gated on the encryption key: disconnecting must keep working on a
      // server that has lost or never had it. `disconnectConfluence` tries to
      // open the sealed refresh token so it can attempt to withdraw the grant
      // at Atlassian, but that attempt is best-effort — a missing key, like an
      // unreachable Atlassian or an endpoint Atlassian does not offer, still
      // leaves the credentials deleted and the row disconnected. `deps` is
      // passed so the attempt is made with the same Atlassian client the
      // connection was made with.
      const { revoked } = await disconnectConfluence(prisma, { integrationId: integration.id }, deps);

      // 204 either way: the charity's disconnect succeeded, and it is not
      // their problem that Atlassian offers us no documented way to hand the
      // authorisation back. But an unconfirmed withdrawal must not be a
      // discarded return value — this is the only place an operator can learn
      // that a grant may still be standing. Expected to be the common case:
      // see the endpoint comment in `disconnectConfluence`. No token, no
      // secret and no Atlassian error text goes into this line.
      if (!revoked) {
        request.log.warn(
          { integrationId: integration.id, provider: PROVIDER },
          'Confluence disconnected and its stored credentials deleted, but the authorisation ' +
            'could not be confirmed as withdrawn at Atlassian (which documents no revocation ' +
            'endpoint for an app). The grant expires after 90 days without use, or the ' +
            'administrator can remove CharityPilot in their Atlassian connected-apps settings.',
        );
      }
      return sendNoContent(reply);
    } catch (error) {
      handleError(reply, error);
    }
  });
}
