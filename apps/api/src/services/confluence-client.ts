import { AppError } from '../utils/errors.js';

/**
 * The HTTP core of the Confluence client: base URL, auth, retry policy and
 * error taxonomy. Nothing above it decides *what* to publish; everything above
 * it depends on this module never turning one write into two.
 *
 * ## Why the retry policy is asymmetric
 *
 * Confluence rate-limits on a points model and answers 429 with `Retry-After`.
 * Atlassian's guidance is to retry at most four times — but only requests that
 * are safe to repeat. Creating a page is not one of them: a 429, a timeout or a
 * dropped connection *after* Confluence has committed the write turns a naive
 * retry into two identical governance documents in a charity's space. For a
 * product whose whole purpose is an auditable record, a silently duplicated
 * policy is worse than a failed publish.
 *
 * So: only `spec.idempotent` requests are ever retried, and a non-idempotent
 * request whose outcome is unknown surfaces that ambiguity
 * (`CONFLUENCE_REQUEST_INDETERMINATE`) rather than resolving it by guessing.
 * The caller — which knows what it tried to create — can reconcile by
 * searching for it. This module cannot.
 *
 * `idempotent` is the caller's assertion, not something inferred from the HTTP
 * method: `PUT /pages/{id}` is safe only because v2 requires the caller to send
 * the version it expects, so a repeat of an applied update fails the version
 * check instead of applying twice. A `PUT` without that guarantee is not
 * idempotent and must not be marked as one.
 */

/**
 * The deadline on a single Confluence request.
 *
 * Unbounded, undici's defaults apply: `headersTimeout` 300s plus `bodyTimeout`
 * 300s, about ten minutes in which a stalled Atlassian holds a publish job (or
 * a request-scoped caller) open while saying nothing. Thirty seconds is two
 * orders of magnitude inside that, and is generous for a single Confluence
 * call: page reads and writes answer in well under a second, so anything past
 * thirty seconds is a stall rather than slowness.
 *
 * It is deliberately not shorter. This deadline is what turns a hung
 * connection into an *error*, and on a non-idempotent request that error is
 * `CONFLUENCE_REQUEST_INDETERMINATE` — a real cost to the caller, who must then
 * reconcile. Cutting a working-but-slow write off early would manufacture
 * exactly the ambiguity this module exists to keep rare.
 *
 * **This bounds one attempt, not one `request()`.** See
 * `CONFLUENCE_TOTAL_DEADLINE_MS` for what a caller is actually signing up for.
 */
export const CONFLUENCE_REQUEST_TIMEOUT_MS = 30 * 1000;

/**
 * The bound on a whole `request()` call, retries and backoffs included.
 *
 * Without it the per-attempt deadline is misleading arithmetic: five attempts
 * at 30s plus four backoffs clamped at 60s is about 390s, which is *worse*
 * than the ~600s undici default the per-attempt deadline exists to beat, once
 * retries are counted. A caller reading "30 seconds" would be wrong by an
 * order of magnitude.
 *
 * Two minutes is the number because a retrying request is by definition
 * waiting on a rate limit or a fault, and no caller — a publish job included —
 * is better off holding a connection for six minutes to find that out. It is
 * enough for two honest 60s `Retry-After` waits, or for four exponential
 * backoffs and five attempts against a merely slow site.
 *
 * It is checked *before sleeping*, never mid-attempt: an attempt already in
 * flight is bounded by its own deadline and is never abandoned part-way,
 * because abandoning an in-flight write is what manufactures an indeterminate
 * outcome. So the true worst case is this budget plus one attempt.
 */
export const CONFLUENCE_TOTAL_DEADLINE_MS = 120 * 1000;

/** One attempt plus at most four retries, per Atlassian's published guidance. */
export const CONFLUENCE_MAX_ATTEMPTS = 5;

/** The first exponential-backoff step, doubled per retry. */
const BASE_BACKOFF_MS = 500;

/**
 * No single wait exceeds this, including one Confluence asked for. A
 * `Retry-After` longer than a minute is clamped rather than obeyed: the
 * attempt cap bounds the damage of retrying slightly early, whereas obeying an
 * arbitrary delay would let an upstream header pin a caller open indefinitely.
 */
const MAX_BACKOFF_MS = 60 * 1000;

/**
 * Jitter is *added* to the computed delay, never subtracted from it, so a
 * retry can never land earlier than Confluence asked. Its purpose is to stop
 * many tenants that were rate-limited at the same instant from resynchronising
 * on the same retry instant.
 */
const JITTER_FRACTION = 0.25;

/** Upstream error text is surfaced only in this quantity; never the raw body. */
const MAX_UPSTREAM_DETAIL_CHARS = 200;

const API_BASE = 'https://api.atlassian.com/ex/confluence';

/**
 * Atlassian issues a cloud id as a UUID. The pattern is deliberately a little
 * wider than a UUID (any bounded alphanumeric-and-hyphen token) so a future
 * change of shape on their side does not break every charity at once — but it
 * admits no `/`, `.`, `?`, `#`, whitespace or control character, which is what
 * matters: the id arrives from Atlassian's accessible-resources response and is
 * then stored, so by the time it is interpolated into a URL it is data, and it
 * must not be able to walk out of the path it belongs in.
 */
const CLOUD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export type ConfluenceClientDeps = {
  fetch?: typeof globalThis.fetch;
  /** Milliseconds since the epoch; used to resolve a date-form `Retry-After`. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The jitter source. Injected so a test can assert an exact backoff. */
  random?: () => number;
  /** Overrides `CONFLUENCE_REQUEST_TIMEOUT_MS`; exists so a test can use a short deadline. */
  timeoutMs?: number;
  /**
   * Builds the per-attempt deadline signal. Defaults to `AbortSignal.timeout`.
   *
   * It exists so a test can observe *the number the call site actually passes*.
   * Pinning `resolveRequestTimeoutMs({})` alone pins the function and not the
   * join: replacing the call site with a hardcoded 600000 left every test
   * green, which is the previous phase's mistake in a subtler form.
   */
  createSignal?: (ms: number) => AbortSignal;
};

export type ConfluenceRequestSpec = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** `v2` for pages, spaces and properties; `v1` only where v2 has no endpoint (attachment upload). */
  api: 'v1' | 'v2';
  /** Relative to the API prefix, e.g. `pages/42`. No leading slash, no query string. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  formData?: FormData;
  /** Extra request headers, e.g. v1 upload's required `X-Atlassian-Token: nocheck`. Cannot displace `Authorization`. */
  headers?: Record<string, string>;
  /**
   * The caller's assertion that repeating this exact request cannot create or
   * duplicate anything. Only these are ever retried automatically. Getting it
   * wrong on a page create is how a charity ends up with two copies of a
   * policy, so it is required rather than defaulted.
   */
  idempotent: boolean;
};

export type ConfluenceResponse = {
  status: number;
  /** The parsed JSON body, or `undefined` for a 204/empty/non-JSON response. */
  body: unknown;
};

export type ConfluenceClient = {
  request(spec: ConfluenceRequestSpec): Promise<ConfluenceResponse>;
};

/**
 * The production deadline, resolved in one place.
 *
 * It exists to be *asserted on*. The one test that exercises a real abort
 * injects its own five milliseconds, so the fallback — the number that
 * actually runs in production — is reached by nothing else in the suite.
 * Written inline at the call site, replacing it with undici's default would
 * leave every test green. This function pins the join.
 */
export function resolveRequestTimeoutMs(deps: ConfluenceClientDeps): number {
  return deps.timeoutMs ?? CONFLUENCE_REQUEST_TIMEOUT_MS;
}

function invalidCloudId(): AppError {
  // Deliberately does not echo the value: it is untrusted data from an
  // upstream response, and a diagnostic is not a place to replay it.
  return new AppError(
    500,
    'CONFLUENCE_CLOUD_ID_INVALID',
    'The stored Confluence site identifier is not a usable cloud id.',
  );
}

function assertValidCloudId(cloudId: string): string {
  if (typeof cloudId !== 'string' || !CLOUD_ID_PATTERN.test(cloudId)) throw invalidCloudId();
  return cloudId;
}

function hasControlCharacter(text: string): boolean {
  // Written as a code-point test rather than a regex range so no literal
  // control character ever has to appear in this file's source.
  return Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

/**
 * Validates the request path in the same spirit as
 * `assertOrganisationStoragePath`: reject rather than sanitise, so a caller
 * that interpolated an id it had not checked fails loudly instead of quietly
 * addressing something else. `..` is the whole point — without this, an
 * unvalidated page id in Task 2 or 3 could climb out of the API prefix.
 */
function assertValidPath(path: string): string {
  const segments = path.split('/');
  const invalid =
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 512 ||
    path.startsWith('/') ||
    // `%` too: a percent-encoded `%2e%2e` would pass the segment check below
    // and still be decoded into a traversal by whatever sits in front of
    // Confluence. Paths here address ids; anything needing encoding is a query
    // parameter, and `query` encodes those properly.
    /[?#\\%]/.test(path) ||
    hasControlCharacter(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..');

  if (invalid) {
    throw new AppError(
      500,
      'CONFLUENCE_REQUEST_PATH_INVALID',
      'A Confluence request path must be a relative path with no traversal, query string or control characters.',
    );
  }
  return path;
}

function buildUrl(cloudId: string, spec: ConfluenceRequestSpec): string {
  const prefix = spec.api === 'v2' ? 'wiki/api/v2' : 'wiki/rest/api';
  const url = new URL(`${API_BASE}/${cloudId}/${prefix}/${assertValidPath(spec.path)}`);
  for (const [key, value] of Object.entries(spec.query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Replaces the access token wherever it might have reached a string bound for
 * an error.
 *
 * Confluence does not echo an Authorization header back in an error body, and
 * nothing here deliberately puts one anywhere but the header itself — this is
 * the belt to that braces. The containment rule ("a token never leaves the
 * credential boundary") does not get to depend on an upstream service's good
 * behaviour, and the cost of not depending on it is one string replacement.
 */
function redactToken(text: string, token: string): string {
  if (token.length === 0) return text;
  return text.split(token).join('[redacted]');
}

function truncate(text: string): string {
  return text.length <= MAX_UPSTREAM_DETAIL_CHARS ? text : `${text.slice(0, MAX_UPSTREAM_DETAIL_CHARS)}...`;
}

/**
 * The only fields ever taken off an upstream error body.
 *
 * v2 answers `{ errors: [{ status, code, title, detail }] }` and v1 answers
 * `{ statusCode, message }`. Everything else on the body is discarded unread,
 * because a raw body is not ours to surface: it can carry whatever Atlassian
 * (or a proxy in front of it) chose to put there, including a reflection of
 * the request.
 */
function extractUpstreamDetail(body: unknown, token: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined;

  const asV1 = body as { message?: unknown };
  const asV2 = body as { errors?: unknown };

  let text: string | undefined;

  if (Array.isArray(asV2.errors) && asV2.errors.length > 0) {
    const first = asV2.errors[0] as { title?: unknown; detail?: unknown } | null;
    const title = first && typeof first.title === 'string' ? first.title : undefined;
    const detail = first && typeof first.detail === 'string' ? first.detail : undefined;
    text = title && detail ? `${title}: ${detail}` : (title ?? detail);
  }

  if (text === undefined && typeof asV1.message === 'string') text = asV1.message;
  if (text === undefined || text.length === 0) return undefined;

  return truncate(redactToken(text, token));
}

/** Reads the error body once, tolerating an unreadable or non-JSON one. */
async function readErrorDetail(response: Response, token: string): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (text.trim().length === 0) return undefined;
    return extractUpstreamDetail(JSON.parse(text) as unknown, token);
  } catch {
    return undefined;
  }
}

/**
 * The write landed and we lost the identifier.
 *
 * This is the last case of the same argument the 5xx branch makes, and it is
 * the more certain one: the status line was already 2xx when the body failed,
 * so Confluence did not merely *see* the request — it **committed** it. What
 * was lost is only the id of the thing it created.
 *
 * It is reachable outside a harness: a body truncated on a slow connection, a
 * gateway that answers 201 with an HTML error page, or this module's own
 * deadline firing part-way through reading the body. A caller told
 * "the response could not be read" would reasonably conclude nothing landed
 * and create the page again — two identical governance documents in a
 * charity's space, through a door the retry policy does not watch.
 *
 * Deliberately a distinct code from `CONFLUENCE_REQUEST_INDETERMINATE`,
 * because the instruction to the caller is stronger and different: do not
 * reissue this. Search for what was created and adopt it.
 */
function writeAppliedResponseUnreadable(status: number, reason: string): AppError {
  return new AppError(
    502,
    'CONFLUENCE_WRITE_APPLIED_RESPONSE_UNREADABLE',
    `Confluence accepted a request that is not safe to repeat (status ${status}), but ${reason}. ` +
      'The change WAS applied and only its identifier was lost. Do not reissue it: ' +
      'find what was created and adopt it.',
    { status },
  );
}

function invalidSuccessResponse(reason: string): AppError {
  return new AppError(502, 'CONFLUENCE_RESPONSE_INVALID', `Confluence returned ${reason}.`);
}

/**
 * `idempotent` is threaded in here for one reason: on a 2xx, an unreadable
 * body means something different depending on whether repeating the request is
 * safe. For a GET it is a broken response; for a page create it is a page that
 * now exists and cannot be found by id.
 */
async function parseSuccessBody(response: Response, idempotent: boolean): Promise<unknown> {
  const status = response.status;

  // An explicit "no content" is not a lost identifier: it is a success that
  // was never going to carry one.
  if (status === 204 || status === 205) return undefined;

  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().includes('json')) {
    if (!idempotent) {
      // A 201 with `Content-Type: text/html` used to return `{ status: 201 }`
      // silently, which reads to a caller as a clean success with no id.
      throw writeAppliedResponseUnreadable(status, 'the response was not JSON');
    }
    return undefined;
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    // Includes this module's own deadline firing mid-body.
    if (!idempotent) throw writeAppliedResponseUnreadable(status, 'its response body could not be read');
    throw invalidSuccessResponse('a response body that could not be read');
  }

  if (text.trim().length === 0) {
    if (!idempotent) throw writeAppliedResponseUnreadable(status, 'its response body was empty');
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A caller that trusted `undefined` here would persist a page with no id.
    if (!idempotent) throw writeAppliedResponseUnreadable(status, 'its response body was not valid JSON');
    throw invalidSuccessResponse('a response that claimed to be JSON but was not');
  }
}

/**
 * Atlassian's 401/403 mean "this stored grant is unusable" — but apps/web's
 * axios interceptors treat any 401 from OUR API as an expired CharityPilot
 * session and bounce the user to the login screen, and a 403 invites
 * "access denied" handling around what is really a stale integration
 * credential. 409 says what is actually true: the request and the user's own
 * session are fine, and it is the stored Confluence connection that conflicts
 * with the assumption that it still works. This mirrors
 * `atlassian-oauth.ts`'s reasoning, which is the house precedent.
 */
const RECONNECT_REQUIRED_STATUS_CODE = 409;

function describe(status: number, detail: string | undefined, suffix?: string): string {
  const head = `Confluence request failed with status ${status}`;
  const withDetail = detail ? `${head}: ${detail}` : `${head}.`;
  return suffix ? `${withDetail} ${suffix}` : withDetail;
}

/** Maps a non-retryable (or retry-exhausted) response to the taxonomy. */
function upstreamFailure(status: number, detail: string | undefined): AppError {
  const details = { status };

  if (status === 401 || status === 403) {
    return new AppError(
      RECONNECT_REQUIRED_STATUS_CODE,
      'CONFLUENCE_RECONNECT_REQUIRED',
      describe(status, detail, 'The charity must reconnect its Confluence site.'),
      details,
    );
  }
  if (status === 404) {
    return new AppError(404, 'CONFLUENCE_NOT_FOUND', describe(status, detail), details);
  }
  if (status === 409) {
    // Confluence's optimistic concurrency: somebody else changed the thing
    // being written. Task 2 turns this into a version conflict carrying the
    // version actually found; it is not a generic failure and must not be
    // buried as one.
    return new AppError(409, 'CONFLUENCE_CONFLICT', describe(status, detail), details);
  }
  if (status === 429) {
    return new AppError(
      429,
      'CONFLUENCE_RATE_LIMITED',
      describe(status, detail, `Confluence was still rate limiting after ${CONFLUENCE_MAX_ATTEMPTS} attempts.`),
      details,
    );
  }

  // A 4xx is the caller's request being wrong and is passed through; anything
  // else is Atlassian failing, which is a 502 from us.
  const statusCode = status >= 400 && status < 500 ? status : 502;
  return new AppError(statusCode, 'CONFLUENCE_REQUEST_FAILED', describe(status, detail), details);
}

function rateLimitedUnsafeRetry(retryAfterSeconds: number | undefined): AppError {
  return new AppError(
    429,
    'CONFLUENCE_RATE_LIMITED_UNSAFE_RETRY',
    'Confluence rate limited a request that is not safe to repeat, so it was not retried: ' +
      'issuing it again could duplicate content. Nothing was changed in Confluence — ' +
      'a 429 is refused before it is processed — so the caller may reissue it later.',
    retryAfterSeconds === undefined ? { status: 429 } : { status: 429, retryAfterSeconds },
  );
}

function indeterminate(status: number | undefined): AppError {
  return new AppError(
    502,
    'CONFLUENCE_REQUEST_INDETERMINATE',
    'A Confluence request that is not safe to repeat did not complete, so it may or may not have been applied. ' +
      'It was deliberately not retried; the caller must reconcile by looking for what it tried to create.',
    status === undefined ? undefined : { status },
  );
}

function unreachable(): AppError {
  return new AppError(
    502,
    'CONFLUENCE_UNREACHABLE',
    `Could not reach Confluence after ${CONFLUENCE_MAX_ATTEMPTS} attempts.`,
  );
}

/**
 * `Retry-After` in milliseconds, or `undefined` when absent or unparseable.
 * RFC 7231 allows both a delay in seconds and an HTTP date; Atlassian sends
 * seconds, but a proxy in between is free to send either.
 */
function parseRetryAfterMs(header: string | null, now: () => number): number | undefined {
  if (header === null) return undefined;

  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : 0;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now());
}

function retryAfterSecondsOf(retryAfterMs: number | undefined): number | undefined {
  return retryAfterMs === undefined ? undefined : Math.round(retryAfterMs / 1000);
}

function backoffMs(attempt: number, retryAfterMs: number | undefined, random: () => number): number {
  // Floored as well as clamped. A `Retry-After: 0` (or a date already in the
  // past) would otherwise buy four zero-delay retries at a service that has
  // just said "slow down", which is the opposite of honouring the header.
  const base = Math.max(retryAfterMs ?? BASE_BACKOFF_MS * 2 ** (attempt - 1), BASE_BACKOFF_MS);
  const jittered = base + random() * JITTER_FRACTION * base;
  return Math.min(Math.round(jittered), MAX_BACKOFF_MS);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function specInvalid(message: string): AppError {
  return new AppError(500, 'CONFLUENCE_REQUEST_SPEC_INVALID', message);
}

/**
 * HTTP header names are case-insensitive, so writing `Authorization` last into
 * a plain object does **not** make it the only one: a caller passing
 * `authorization` produced a header set with both, and the request carried two
 * bearer values. The stated invariant has to be enforced on the *lowercased*
 * name, and the loudest way to enforce it is to refuse the spec rather than
 * silently drop a header the caller believed in.
 */
function assertHeadersDoNotCollide(spec: ConfluenceRequestSpec): void {
  const hasBody = spec.body !== undefined || spec.formData !== undefined;

  for (const key of Object.keys(spec.headers ?? {})) {
    const lower = key.toLowerCase();
    if (lower === 'authorization') {
      throw specInvalid(
        'A Confluence request may not set its own Authorization header; the client builds it from the token provider.',
      );
    }
    if (lower === 'content-type' && hasBody) {
      // For FormData this would lose the multipart boundary; for a JSON body
      // it would contradict what is actually being sent.
      throw specInvalid(
        'A Confluence request may not set its own Content-Type when it carries a body; the client derives it.',
      );
    }
  }
}

function buildInit(
  spec: ConfluenceRequestSpec,
  token: string,
  timeoutMs: number,
  createSignal: (ms: number) => AbortSignal,
): RequestInit {
  const headers: Record<string, string> = { Accept: 'application/json', ...spec.headers };

  let body: RequestInit['body'];
  if (spec.formData !== undefined) {
    // Handed to fetch untouched: it sets the multipart boundary, and a
    // Content-Type written here would be missing it.
    body = spec.formData;
  } else if (spec.body !== undefined) {
    body = JSON.stringify(spec.body);
    headers['Content-Type'] = 'application/json';
  }

  // Last, and never from `spec.headers` — a colliding key was refused in the
  // pre-flight above. Constructed here, at the moment of the call, and never
  // stored anywhere.
  headers.Authorization = `Bearer ${token}`;

  return {
    method: spec.method,
    headers,
    body,
    signal: createSignal(timeoutMs),
    // A 307/308 re-issues the method and body at the new location. Against a
    // fixed Atlassian origin that is unlikely, but "unlikely" is not a reason
    // to let a write be silently re-sent somewhere else: refusing routes it
    // into the transport branch, which for a non-idempotent request is the
    // indeterminate path where it belongs.
    redirect: 'error',
  };
}

export function createConfluenceClient(
  opts: { cloudId: string; getAccessToken: () => Promise<string> },
  deps: ConfluenceClientDeps = {},
): ConfluenceClient {
  const cloudId = assertValidCloudId(opts.cloudId);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? (() => Math.random());
  const timeoutMs = resolveRequestTimeoutMs(deps);
  const createSignal = deps.createSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  async function request(spec: ConfluenceRequestSpec): Promise<ConfluenceResponse> {
    if (spec.body !== undefined && spec.formData !== undefined) {
      throw specInvalid('A Confluence request carries either a JSON body or form data, never both.');
    }
    assertHeadersDoNotCollide(spec);

    // Compared with `!== true`, not with `!`. TypeScript already forbids
    // anything but a boolean, but this one flag is the whole distance between
    // a charity and a duplicated policy, and a truthy value reaching it from
    // untyped JSON (the string `'false'` retried five times) is not a risk
    // worth carrying for nothing.
    const idempotent = spec.idempotent === true;

    const url = buildUrl(cloudId, spec);
    const startedAt = now();

    /**
     * The overall budget, checked before every sleep. An attempt already in
     * flight is bounded by its own signal and is never abandoned part-way:
     * abandoning an in-flight write is precisely how an indeterminate outcome
     * is manufactured.
     */
    const budgetExhausted = (delayMs: number): boolean =>
      now() - startedAt + delayMs > CONFLUENCE_TOTAL_DEADLINE_MS;

    for (let attempt = 1; attempt <= CONFLUENCE_MAX_ATTEMPTS; attempt += 1) {
      // Per attempt, not per client and not per operation: a backoff or a slow
      // publish can outlive an access token, and the provider refreshes under
      // Phase 2's fenced claim when it needs to. This module never learns what
      // rotation is.
      const token = await opts.getAccessToken();

      let response: Response;
      try {
        response = await fetchImpl(url, buildInit(spec, token, timeoutMs, createSignal));
      } catch {
        // A transport failure or the deadline firing. The underlying error is
        // never attached as `cause`: Node's `fetch failed` chain carries
        // request detail, and the request logger serialises `cause` verbatim.
        //
        // The request may already have reached Confluence and been applied —
        // nothing here can tell. For anything unsafe to repeat that is the
        // indeterminate case, and it is the caller's to reconcile.
        if (!idempotent) throw indeterminate(undefined);
        if (attempt === CONFLUENCE_MAX_ATTEMPTS) throw unreachable();
        const delayMs = backoffMs(attempt, undefined, random);
        if (budgetExhausted(delayMs)) throw unreachable();
        await sleep(delayMs);
        continue;
      }

      if (response.ok) {
        return { status: response.status, body: await parseSuccessBody(response, idempotent) };
      }

      const status = response.status;
      const detail = await readErrorDetail(response, token);

      if (status === 429) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'), now);

        // A 429 is refused *before* it is processed, so unlike a 5xx it is not
        // ambiguous — nothing was applied. It is still not retried here: the
        // caller decides when to reissue something that could duplicate
        // content, and it is handed the delay Confluence asked for.
        if (!idempotent) throw rateLimitedUnsafeRetry(retryAfterSecondsOf(retryAfterMs));

        if (attempt === CONFLUENCE_MAX_ATTEMPTS) throw upstreamFailure(status, detail);
        const delayMs = backoffMs(attempt, retryAfterMs, random);
        if (budgetExhausted(delayMs)) throw upstreamFailure(status, detail);
        await sleep(delayMs);
        continue;
      }

      if (status >= 500) {
        // Confluence saw the request. Whether it committed the write before
        // failing is exactly what a 5xx does not say, so for a non-idempotent
        // request this is indeterminate rather than a plain failure: a caller
        // told "it failed" would reasonably retry and duplicate the document.
        if (!idempotent) throw indeterminate(status);

        if (attempt === CONFLUENCE_MAX_ATTEMPTS) throw upstreamFailure(status, detail);
        const delayMs = backoffMs(attempt, undefined, random);
        if (budgetExhausted(delayMs)) throw upstreamFailure(status, detail);
        await sleep(delayMs);
        continue;
      }

      // Any other 4xx fails identically forever. Retrying it would burn
      // rate-limit budget and delay the real error.
      throw upstreamFailure(status, detail);
    }

    // Unreachable: every branch of the loop returns, throws, or continues, and
    // the last attempt always throws. Present only to satisfy the compiler.
    throw unreachable();
  }

  return { request };
}
