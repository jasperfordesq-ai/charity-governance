import { configuredApiOrigin } from './api';
import { apiErrorMessage } from './errors';

// The API refuses unsafe requests whose Origin is not on its allow-list
// (`apps/api/src/utils/request-origin.ts`) BEFORE any handler runs, so an
// origin-rejected sign-in never reaches the credential check. Reporting that as
// "Invalid email or password" sends an operator to reset passwords when the real
// problem is the address they are reaching the server on.
//
// Two shapes of the same rejection have to be recognised:
//   1. The browser can read the 403 body (same-origin request) -> code
//      INVALID_ORIGIN / MISSING_ORIGIN.
//   2. The browser cannot read it. @fastify/cors omits Access-Control-Allow-Origin
//      for a disallowed origin, so a cross-origin login is blocked at the CORS
//      layer (usually at the preflight) and axios reports a request with NO
//      response at all. This is the shape seen through an SSH tunnel to a
//      Tailscale-hosted private server.
const PERSONAL_SERVER_DEPLOYMENT =
  process.env.NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE === 'personal-server';

export type AuthFailureKind =
  | 'origin-rejected'
  | 'origin-missing'
  | 'origin-unreachable'
  | 'unreachable'
  | 'answered';

export type AuthFailureNotice = {
  /** Alert heading. Undefined keeps the FormAlert default ("Check the details"). */
  title?: string;
  message: string;
};

export type AuthRequestOrigins = {
  pageOrigin?: string;
  apiOrigin?: string;
  /**
   * Personal-server installs deliberately serve the web app and the browser API
   * from ONE public origin, so a page origin that differs from the configured
   * API origin proves the browser is not on the address this server answers on.
   * Multi-tenant deployments are legitimately cross-origin (web + api.* hosts),
   * so the same comparison proves nothing there and must not be used.
   */
  isPersonalServer?: boolean;
};

// None of these name the configured origin: the value must not be handed to an
// unauthenticated caller, and the operator can get it from whoever set the server up.
export const ORIGIN_REJECTED_TITLE = 'Wrong address for this server';
export const ORIGIN_REJECTED_MESSAGE =
  'This server only answers requests sent to its own configured address, and the address you are using does not match. It refused this request before the details you submitted were checked. Open the server on its configured address — ask whoever set it up if you are not sure which one it is — and try again.';

export const ORIGIN_MISSING_TITLE = 'This request had no checkable address';
export const ORIGIN_MISSING_MESSAGE =
  'This server could not confirm which address the request came from, so it refused the request before the details you submitted were checked. A proxy or tunnel in front of the server is the usual cause: reach the server on its configured address, or ask whoever set it up to stop stripping the browser Origin header.';

export const ORIGIN_UNREACHABLE_TITLE = 'No usable answer from this address';
export const ORIGIN_UNREACHABLE_MESSAGE =
  'The server gave no usable answer, and the address you are using is not the one this server is configured to answer on. The details you submitted were not checked. Open the server on its configured address — ask whoever set it up if you are not sure which one it is — and try again.';

export const UNREACHABLE_TITLE = 'No answer from the server';
export const UNREACHABLE_MESSAGE =
  'The server gave no answer, so the details you submitted were not checked. Check that the server is running and reachable, then try again.';

export const ACCOUNT_SUSPENDED_TITLE = 'This account is no longer active';
export const ORGANISATION_SUSPENDED_TITLE = 'This organisation is suspended';
export const ORGANISATION_CLOSED_TITLE = 'This organisation is closed';

const LIFECYCLE_TITLES: Record<string, string> = {
  ACCOUNT_SUSPENDED: ACCOUNT_SUSPENDED_TITLE,
  ORGANISATION_SUSPENDED: ORGANISATION_SUSPENDED_TITLE,
  ORGANISATION_CLOSED: ORGANISATION_CLOSED_TITLE,
};

type ErrorResponse = {
  status?: unknown;
  data?: { code?: unknown } | null;
} | null;

function errorResponse(error: unknown): ErrorResponse | undefined {
  const response = (error as { response?: ErrorResponse })?.response;
  return response ?? undefined;
}

// Only axios request failures may be read as "the server never answered". A
// stray TypeError from the submit handler must not be reported as a dead server.
function isRequestFailureWithoutResponse(error: unknown): boolean {
  const candidate = error as { isAxiosError?: unknown; response?: unknown };
  return candidate?.isAxiosError === true && !candidate.response;
}

function originValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function isKnownOriginMismatch(origins: AuthRequestOrigins): boolean {
  if (!origins.isPersonalServer) return false;

  const pageOrigin = originValue(origins.pageOrigin);
  const apiOrigin = originValue(origins.apiOrigin);
  // An unknown origin on either side is not evidence of a mismatch.
  if (!pageOrigin || !apiOrigin) return false;

  return pageOrigin !== apiOrigin;
}

export function currentAuthRequestOrigins(): AuthRequestOrigins {
  return {
    pageOrigin: typeof window === 'undefined' ? undefined : window.location.origin,
    apiOrigin: configuredApiOrigin,
    isPersonalServer: PERSONAL_SERVER_DEPLOYMENT,
  };
}

export function classifyAuthFailure(
  error: unknown,
  origins: AuthRequestOrigins = currentAuthRequestOrigins(),
): AuthFailureKind {
  const response = errorResponse(error);

  if (response) {
    if (response.status === 403) {
      const code = response.data?.code;
      if (code === 'INVALID_ORIGIN') return 'origin-rejected';
      if (code === 'MISSING_ORIGIN') return 'origin-missing';
    }
    return 'answered';
  }

  if (!isRequestFailureWithoutResponse(error)) return 'answered';

  return isKnownOriginMismatch(origins) ? 'origin-unreachable' : 'unreachable';
}

/**
 * Turns an auth API failure into what the form should actually say. `fallback`
 * is used only when the server DID answer and supplied no message of its own —
 * a fallback that asserts a cause ("invalid password", "link expired") must
 * never be shown for a request the server refused or never answered.
 */
export function authFailureNotice(
  error: unknown,
  fallback: string,
  origins: AuthRequestOrigins = currentAuthRequestOrigins(),
): AuthFailureNotice {
  switch (classifyAuthFailure(error, origins)) {
    case 'origin-rejected':
      return { title: ORIGIN_REJECTED_TITLE, message: ORIGIN_REJECTED_MESSAGE };
    case 'origin-missing':
      return { title: ORIGIN_MISSING_TITLE, message: ORIGIN_MISSING_MESSAGE };
    case 'origin-unreachable':
      return { title: ORIGIN_UNREACHABLE_TITLE, message: ORIGIN_UNREACHABLE_MESSAGE };
    case 'unreachable':
      return { title: UNREACHABLE_TITLE, message: UNREACHABLE_MESSAGE };
    default: {
      const code = errorResponse(error)?.data?.code;
      const title = typeof code === 'string' ? LIFECYCLE_TITLES[code] : undefined;
      // The server's own message is authoritative here; the title only frames it.
      return title ? { title, message: apiErrorMessage(error, fallback) } : { message: apiErrorMessage(error, fallback) };
    }
  }
}
