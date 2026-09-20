import type { FastifyRequest } from "fastify";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from "./auth-cookie-names.js";
import {
  OWNER_ACCESS_TOKEN_COOKIE,
  OWNER_REFRESH_TOKEN_COOKIE,
} from "./owner-cookies.js";

/**
 * Decides whether a request came from a non-browser client.
 *
 * The connector sign-in routes return tokens in the response body and set no
 * cookie, which is only safe if a web page can never reach them. This is the
 * check that makes that true, and it fails closed in two independent ways.
 *
 * First, the client header is required. It is not a CORS-safelisted header, so
 * any browser must send a preflight before it, and the preflight is refused
 * because the header is deliberately absent from the CORS allowed list. A page
 * therefore cannot send it at all, from any origin.
 *
 * Second, and this is the part that does not depend on CORS being configured
 * correctly, the request is refused outright if it carries any evidence of a
 * browser. An origin, a referer and the Sec-Fetch headers are all forbidden
 * headers: a browser attaches them itself and page script cannot remove or
 * forge them. Node's fetch sends none of them. An auth cookie is refused for
 * the same reason — a signed-in browser has one, a connector never does.
 *
 * Note that an origin is refused even when it is one the API otherwise trusts.
 * The rule is "no origin at all", not "an origin we happen to allow", because
 * the whole point is that no browser reaches here.
 */
export const CONNECTOR_CLIENT_HEADER = "x-charitypilot-client";

/** Only the connector, and only with a version, so a bare truthy value fails. */
const CLIENT_HEADER_PATTERN = /^mcp-connector\/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Headers a browser attaches itself and page script cannot remove or forge.
 *
 * `sec-fetch-mode` is deliberately NOT here, although a browser does send it.
 * Node's own fetch sets `sec-fetch-mode: cors` on every request, so treating
 * it as browser evidence refuses the connector along with the browser. The
 * remaining Sec-Fetch headers are sent by browsers and by nothing else: a
 * page's fetch or XHR always carries `sec-fetch-site` and `sec-fetch-dest`
 * beside the mode, so dropping the one header undetectable clients also send
 * costs no coverage.
 */
const BROWSER_EVIDENCE_HEADERS = [
  "origin",
  "referer",
  "sec-fetch-site",
  "sec-fetch-dest",
] as const;

export type NonBrowserClientResult =
  | { ok: true }
  | {
      ok: false;
      statusCode: 403;
      payload: { error: string; code: "BROWSER_CLIENT_REJECTED" };
    };

function headerValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function refuse(): NonBrowserClientResult {
  // Deliberately says nothing about credentials: this runs before any are
  // checked, and a caller probing the route learns only that it is not for them.
  return {
    ok: false,
    statusCode: 403,
    payload: {
      error: "This endpoint is for the CharityPilot connector, not a browser",
      code: "BROWSER_CLIENT_REJECTED",
    },
  };
}

export function assertNonBrowserClient(
  request: Pick<FastifyRequest, "headers" | "cookies">,
): NonBrowserClientResult {
  const client = headerValue(request.headers[CONNECTOR_CLIENT_HEADER]);
  if (!client || !CLIENT_HEADER_PATTERN.test(client.trim())) return refuse();

  for (const header of BROWSER_EVIDENCE_HEADERS) {
    if (headerValue(request.headers[header]) !== undefined) return refuse();
  }

  if (
    request.cookies?.[ACCESS_TOKEN_COOKIE] ||
    request.cookies?.[REFRESH_TOKEN_COOKIE] ||
    // The operator console's cookies count as browser evidence for exactly the
    // same reason the tenant ones do, and are checked here rather than only on
    // the owner routes: a connector never holds either, whichever realm it is
    // signing in to, so there is no case where allowing one is right.
    request.cookies?.[OWNER_ACCESS_TOKEN_COOKIE] ||
    request.cookies?.[OWNER_REFRESH_TOKEN_COOKIE]
  ) {
    return refuse();
  }

  return { ok: true };
}
