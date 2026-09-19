/**
 * The logic behind `(dashboard)/integrations/confluence/callback/page.tsx`.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * RENEW THE SESSION, THEN SPEND THE CODE. IN THAT ORDER.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The access-token cookie lives 15 minutes counted from login or the last
 * refresh, not from the moment the administrator clicked Connect. They
 * routinely come back from Atlassian's consent screen with under a minute of
 * session left, and the authorization code Atlassian hands back is
 * single-use. `lib/api.ts`'s single-flight refresh-on-401 exists for the
 * ordinary case, but relying on it *here* means the first POST already
 * carries a dead cookie and burns the code before the retried request lands.
 * So this module refreshes first, unconditionally, and only then spends the
 * code — never the other way round.
 *
 * `code` and `state` are secrets: the query string that carries them reaches
 * access logs, `Referer` headers and browser history (see
 * `apps/api/src/routes/integrations/index.ts`, `bodyParam`, for the API side
 * of the same rule). Nothing in this module ever puts either value into a
 * `CallbackOutcome`, so nothing that renders an outcome — a message, a log
 * line, a thrown error — can leak them. Every outcome message below is a
 * fixed string; none of them is ever built from `input` or from the error
 * an HTTP call rejected with.
 */
import { api, refreshSession } from './api';

export type ConfluenceCallbackInput = {
  code: string;
  state: string;
};

export type ConfluenceCallbackPostResult = {
  siteUrl?: string;
};

export type CallbackOutcome =
  | { kind: 'connected'; siteUrl?: string }
  | { kind: 'session-expired'; message: string }
  | { kind: 'state-invalid'; message: string }
  | { kind: 'code-spent'; message: string }
  | { kind: 'failed'; message: string };

export type ConfluenceCallbackDeps = {
  refresh: () => Promise<void>;
  post: (input: ConfluenceCallbackInput) => Promise<ConfluenceCallbackPostResult>;
};

/**
 * The API's own codes for the failures this page can distinguish. Matching
 * on these (never on a message body, which can vary or, upstream, embed
 * Atlassian's `error_description`) is what lets this module hand back a
 * fixed, safe string of its own instead.
 */
const STATE_INVALID_CODE = 'CONFLUENCE_OAUTH_STATE_INVALID';
const CODE_SPENT_CODE = 'ATLASSIAN_OAUTH_TOKEN_FAILED';

const SESSION_EXPIRED_MESSAGE =
  "Your session expired while you were on Atlassian's screen. Please connect again.";
const STATE_INVALID_MESSAGE =
  'This authorisation could not be verified as one this organisation started. Please connect again from CharityPilot.';
const CODE_SPENT_MESSAGE =
  'This authorisation code has already been used and cannot be spent again. Restart the connection from CharityPilot — retrying will not work.';
const FAILED_MESSAGE = 'Something went wrong while connecting to Confluence. Please try again.';

function responseStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null | undefined)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function responseCode(error: unknown): string | undefined {
  const code = (error as { response?: { data?: { code?: unknown } } } | null | undefined)?.response?.data
    ?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Turns a failed POST into one of the outcomes the page can act on.
 *
 * Deliberately keyed on `status`/`code`, never on any string the failure
 * carried — a message field can hold upstream text this module must not
 * repeat back (see the module doc). Every branch below returns one of the
 * fixed messages declared above.
 */
export function classifyConfluenceCallbackFailure(error: unknown): CallbackOutcome {
  const status = responseStatus(error);

  // A 401 here means the just-refreshed session was already invalid again by
  // the time the code was spent (or the refresh silently failed to stick) —
  // the same actionable problem as a failed refresh, so it gets the same
  // outcome and words.
  if (status === 401) {
    return { kind: 'session-expired', message: SESSION_EXPIRED_MESSAGE };
  }

  const code = responseCode(error);

  if (code === STATE_INVALID_CODE) {
    return { kind: 'state-invalid', message: STATE_INVALID_MESSAGE };
  }

  if (code === CODE_SPENT_CODE) {
    return { kind: 'code-spent', message: CODE_SPENT_MESSAGE };
  }

  return { kind: 'failed', message: FAILED_MESSAGE };
}

const defaultDeps: ConfluenceCallbackDeps = {
  refresh: refreshSession,
  post: async (input) => {
    // `withCredentials` is pinned explicitly rather than left to the `api`
    // instance's own default: `FRONTEND_URL` and `NEXT_PUBLIC_API_URL` can be
    // different hosts on the hosted profile, so this call is cross-origin,
    // and a cookie-authenticated request that silently drops its cookies
    // would fail in exactly the way this whole page exists to prevent.
    //
    // `skipAuthRefresh`/`skipAuthRedirect`: this module already refreshed the
    // session immediately above (that is the entire point of this file); the
    // interceptor's own reactive refresh-and-retry must not run a second,
    // unordered refresh behind this call's back, and a 401 that survives the
    // explicit refresh is this page's own `session-expired` outcome to show —
    // not a redirect to `/login` out from under it.
    const response = await api.post<ConfluenceCallbackPostResult>(
      '/integrations/confluence/callback',
      { code: input.code, state: input.state },
      { withCredentials: true, skipAuthRefresh: true, skipAuthRedirect: true },
    );
    return { siteUrl: response.data?.siteUrl };
  },
};

export async function completeConfluenceCallback(
  input: ConfluenceCallbackInput,
  deps: Partial<ConfluenceCallbackDeps> = {},
): Promise<CallbackOutcome> {
  const { refresh, post } = { ...defaultDeps, ...deps };

  try {
    await refresh();
  } catch {
    // A failed refresh is a session problem, not a generic failure — and it
    // is reported before the code is ever spent, so it is still true that
    // retrying (by reconnecting) will work.
    return { kind: 'session-expired', message: SESSION_EXPIRED_MESSAGE };
  }

  try {
    const result = await post(input);
    return { kind: 'connected', siteUrl: result.siteUrl };
  } catch (error) {
    return classifyConfluenceCallbackFailure(error);
  }
}
