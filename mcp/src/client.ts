import { randomUUID } from 'node:crypto';
import type { Session } from './session.js';
import { redactSecrets } from './redact.js';
import { CONNECTOR_VERSION } from './version.js';
import { ConnectionError, type ErrorAction } from './errors.js';

const CLIENT_HEADER = 'x-charitypilot-client';
const REASON_HEADER = 'x-charitypilot-reason';
const APPROVAL_HEADER = 'x-charitypilot-approval';
/** The IETF draft spelling, which is what the API reads. */
const IDEMPOTENCY_HEADER = 'idempotency-key';

export interface ValidationDetail {
  field: string;
  message: string;
}

interface ApiErrorExtra {
  code: string | null;
  details: readonly ValidationDetail[];
  retryAfterSeconds: number | null;
  retryable: boolean;
  action: ErrorAction;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: readonly ValidationDetail[];
  readonly retryAfterSeconds: number | null;
  readonly retryable: boolean;
  readonly action: ErrorAction;

  constructor(status: number, message: string, extra: Partial<ApiErrorExtra> = {}) {
    super(redactSecrets(message));
    this.name = 'ApiError';
    this.status = status;
    this.code = extra.code ?? null;
    this.details = extra.details ?? [];
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
    this.retryable = extra.retryable ?? status >= 500;
    this.action = extra.action ?? 'none';
  }
}

/**
 * Raised when CharityPilot will not perform an action until a person approves
 * it.
 *
 * Carries what the human needs and nothing the agent could use to approve on
 * their behalf: an identifier, the server's own description of what will
 * happen, and the command to run. There is no way to satisfy this from here,
 * which is the point.
 */
export class ApprovalRequiredError extends Error {
  readonly code = 'APPROVAL_REQUIRED';
  readonly approvalId: string;
  readonly summary: string;
  readonly command: string;
  readonly expiresAt: string;
  readonly resourceId: string | null;

  constructor(details: {
    approvalId: string;
    summary: string;
    command: string;
    expiresAt: string;
    resourceId: string | null;
  }) {
    super(
      `${details.summary}\n\n`
        + 'CharityPilot will not do this until you approve it yourself. In your own '
        + `terminal, run:\n\n    ${details.command}\n\n`
        + 'You will be shown what you are approving there and asked for your password. '
        + 'Then call this tool again with exactly the same arguments plus '
        + `approvalId: ${details.approvalId}. The approval expires at ${details.expiresAt} `
        + 'and covers only this one action.',
    );
    this.name = 'ApprovalRequiredError';
    this.approvalId = details.approvalId;
    this.summary = details.summary;
    this.command = details.command;
    this.expiresAt = details.expiresAt;
    this.resourceId = details.resourceId;
  }
}

interface ApiClientOptions {
  session: Session;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface WriteOptions {
  /** Why the change is being made. Recorded by the API against the request. */
  reason?: string | undefined;
  /** An approval identifier previously granted by a human at a terminal. */
  approvalId?: string | undefined;
  /**
   * Names this create, so a retry of it is answered rather than carried out
   * again. Filled in automatically for every POST; passed explicitly only by
   * a caller that wants two calls treated as one request.
   */
  idempotencyKey?: string | undefined;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Codes whose `error` text is written for the person making the request and
 * carries nothing about anyone else, so it may be quoted to a model.
 *
 * Everything else keeps its text server-side and is reported by code alone.
 * A code is a token, not free text, so naming it costs nothing; the storage
 * and Confluence families are left out because their messages can embed
 * storage paths, which encode original filenames.
 */
const QUOTABLE_CODES = new Set([
  'SESSION_READ_ONLY',
  'SESSION_LEVEL_TOO_LOW',
  'CONNECTOR_WRITE_LIMIT',
  'BROWSER_CLIENT_REJECTED',
  'VALIDATION_ERROR',
  'FORBIDDEN',
  'PLAN_FEATURE_UNAVAILABLE',
  'EMAIL_NOT_VERIFIED',
  'UNAUTHORIZED',
  'APPROVAL_REFUSED',
  'APPROVAL_RACED',
  'ORGANISATION_INACTIVE',
]);
const QUOTABLE_PATTERNS = [/_NOT_FOUND$/, /_CONFLICT$/, /^DEADLINE_/, /^GENERATED_DEADLINE_/];

function isQuotable(code: string): boolean {
  return QUOTABLE_CODES.has(code) || QUOTABLE_PATTERNS.some((pattern) => pattern.test(code));
}

/**
 * What the agent should do next, by code family. The text is the connector's,
 * never the server's, so it can say things the API has no reason to know, such
 * as which connector command re-connects at a higher level.
 */
function guidanceFor(
  status: number,
  code: string | null,
  retryAfterSeconds: number | null,
): { text: string; action: ErrorAction; retryable: boolean } {
  if (code === 'VALIDATION_ERROR') {
    return { text: 'Correct the fields named above and call again.', action: 'fix_arguments', retryable: false };
  }
  if (code && /_NOT_FOUND$/.test(code)) {
    return {
      text: 'No such record in this charity. Check the identifier against the matching list tool.',
      action: 'fix_arguments',
      retryable: false,
    };
  }
  if (code && (/_CONFLICT$/.test(code) || /^DEADLINE_/.test(code) || /^GENERATED_DEADLINE_/.test(code))) {
    return {
      text: 'The record changed since it was read, or cannot be changed this way. Read it again and retry with its current updatedAt.',
      action: 'reread',
      retryable: true,
    };
  }
  if (code === 'SESSION_READ_ONLY') {
    return {
      text: 'Re-connect with "charitypilot-mcp connect --access-level write" to change records.',
      action: 'reconnect',
      retryable: false,
    };
  }
  if (code === 'SESSION_LEVEL_TOO_LOW') {
    return {
      text: 'Re-connect with "charitypilot-mcp connect --access-level admin".',
      action: 'reconnect',
      retryable: false,
    };
  }
  if (code === 'FORBIDDEN') {
    return {
      text: "Your account's role does not allow this, and re-connecting at another level will not change that.",
      action: 'none',
      retryable: false,
    };
  }
  if (code === 'PLAN_FEATURE_UNAVAILABLE') {
    return { text: 'This needs the Complete plan.', action: 'none', retryable: false };
  }
  if (status === 429) {
    return {
      text: `Wait ${retryAfterSeconds ?? 60} seconds and try again.`,
      action: 'wait',
      retryable: true,
    };
  }
  if (status === 404 && !code) {
    return {
      text: 'CharityPilot has no such route. The API may be running a build older than this connector.',
      action: 'none',
      retryable: false,
    };
  }
  if (status >= 500) {
    return {
      text: 'CharityPilot had an internal problem. Nothing about the request needs to change; try again shortly.',
      action: 'wait',
      retryable: true,
    };
  }
  return { text: '', action: 'none', retryable: false };
}

function validationDetails(raw: unknown): ValidationDetail[] {
  if (!Array.isArray(raw)) return [];
  const out: ValidationDetail[] = [];
  for (const item of raw.slice(0, 20)) {
    const record = item as { field?: unknown; message?: unknown };
    if (typeof record.message !== 'string') continue;
    out.push({
      field: typeof record.field === 'string' && record.field.length > 0 ? record.field.slice(0, 200) : '(body)',
      message: record.message.slice(0, 200),
    });
  }
  return out;
}

function retryAfterFrom(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : null;
}

export class ApiClient {
  readonly #session: Session;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.#session = options.session;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get<T>(path: string): Promise<T> {
    return this.#request<T>('GET', path, undefined, {});
  }

  /**
   * A create, named so it happens once.
   *
   * Every POST carries a fresh key unless the caller supplied one. It costs a
   * header and it makes the one failure this connector cannot otherwise
   * survive recoverable: a connection that drops after the API committed,
   * where the agent cannot tell a record that was created from one that was
   * not, and retrying is the only thing it can reasonably do.
   */
  post<T>(path: string, body: unknown, options: WriteOptions = {}): Promise<T> {
    return this.#request<T>('POST', path, body, {
      ...options,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    });
  }

  patch<T>(path: string, body: unknown, options: WriteOptions = {}): Promise<T> {
    return this.#request<T>('PATCH', path, body, options);
  }

  put<T>(path: string, body: unknown, options: WriteOptions = {}): Promise<T> {
    return this.#request<T>('PUT', path, body, options);
  }

  delete<T>(path: string, options: WriteOptions = {}): Promise<T> {
    return this.#request<T>('DELETE', path, undefined, options);
  }

  /**
   * Uploads a file as multipart form data.
   *
   * Kept apart from the JSON verbs because almost nothing is shared: no
   * content-type is set, since the runtime writes the multipart boundary
   * itself, and the body is a FormData rather than a serialised object.
   */
  async upload<T>(
    path: string,
    file: { name: string; mimeType: string; bytes: Buffer },
    fields: Record<string, string>,
    options: WriteOptions = {},
  ): Promise<T> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append(
      'file',
      new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }),
      file.name,
    );
    return this.#send<T>('POST', path, form, options);
  }

  /**
   * Fetches a document's bytes.
   *
   * Returns the body rather than parsing it, because a stored document is not
   * JSON and the personal-data gate cannot filter a file.
   */
  async download(
    path: string,
    isRetry = false,
  ): Promise<{ bytes: Buffer; fileName: string | null }> {
    const token = await this.#session.accessToken();
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        [CLIENT_HEADER]: `mcp-connector/${CONNECTOR_VERSION}`,
      },
    });

    // The same one-shot retry the JSON verbs get: a 401 fifteen minutes into
    // a session is an expired access token, not a dead session.
    if (response.status === 401 && !isRetry) {
      this.#session.invalidateAccessToken();
      return this.download(path, true);
    }

    if (!response.ok) {
      throw await this.#refusal(response);
    }

    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);

    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      fileName: match?.[1] ? decodeURIComponent(match[1]) : null,
    };
  }

  #request<T>(
    method: Method,
    path: string,
    body: unknown,
    options: WriteOptions,
  ): Promise<T> {
    return this.#send<T>(
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      options,
      body !== undefined,
    );
  }

  async #send<T>(
    method: Method,
    path: string,
    body: string | FormData | undefined,
    options: WriteOptions,
    isJson = false,
    // Each recovery is taken at most once, and they are tracked separately so
    // a token refresh does not spend the dropped-connection attempt, or the
    // other way round.
    retried: { unauthorised?: boolean; connection?: boolean } = {},
  ): Promise<T> {
    const token = await this.#session.accessToken();

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      [CLIENT_HEADER]: `mcp-connector/${CONNECTOR_VERSION}`,
    };
    // FormData sets its own content-type, including the boundary, so one set
    // here would produce a body the server cannot parse.
    if (isJson) headers['content-type'] = 'application/json';
    // Capped here as well as at the API, so an over-long reason is trimmed
    // rather than silently dropped by the server's own limit.
    if (options.reason) headers[REASON_HEADER] = options.reason.slice(0, 500);
    if (options.approvalId) headers[APPROVAL_HEADER] = options.approvalId;
    if (options.idempotencyKey) headers[IDEMPOTENCY_HEADER] = options.idempotencyKey;

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
    } catch (cause) {
      // A create that met a dropped connection may already have happened, and
      // nothing on this side can tell. With a key it is safe to ask again:
      // the API either carries it out, never having seen the first attempt,
      // or answers with the result of the attempt it did see. Without a key
      // the failure is reported instead, because a blind retry is how one
      // board meeting becomes two.
      if (
        options.idempotencyKey !== undefined
        && !retried.connection
        && !(body instanceof FormData)
      ) {
        return this.#send<T>(method, path, body, options, isJson, {
          ...retried,
          connection: true,
        });
      }
      throw new ConnectionError(
        'Cannot reach CharityPilot. Check that Tailscale is connected. '
          + `(${redactSecrets((cause as Error).message)})`,
      );
    }

    // A 401 means the ~15-minute access token expired mid-session. The stored refresh
    // token is very likely still good, so drop the cached access token and retry ONCE.
    // Without this, every access-token expiry surfaces a spurious "reconnect" prompt
    // even though the next call would have succeeded — which defeats the whole point
    // of implementing refresh rotation. Bounded to one attempt so a genuinely dead
    // session still fails fast instead of looping.
    if (response.status === 401 && !retried.unauthorised) {
      this.#session.invalidateAccessToken();
      // A FormData body cannot be replayed once consumed, so an upload that
      // meets an expired token is reported rather than retried silently.
      if (body instanceof FormData) {
        throw new ApiError(
          401,
          'The session expired while the file was being sent. Nothing was uploaded; '
            + 'ask again and it will be retried with a fresh session.',
        );
      }
      return this.#send<T>(method, path, body, options, isJson, {
        ...retried,
        unauthorised: true,
      });
    }
    if (response.status === 401) {
      throw new ApiError(401, 'Session expired. Run: charitypilot-mcp connect');
    }

    if (response.status === 428) {
      throw await this.#approvalRequired(response);
    }

    if (!response.ok) {
      throw await this.#refusal(response);
    }

    // A successful removal answers 204 with no body, which is correct and is
    // not an error. Insisting on JSON here made every delete look like a
    // broken connection to whoever called it.
    if (response.status === 204) {
      return { ok: true, status: 204 } as T;
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError(
        response.status,
        'CharityPilot returned a response that was not JSON. If you are behind a captive '
          + 'portal or proxy, check the connection and try again.',
      );
    }
  }

  async #approvalRequired(response: Response): Promise<Error> {
    const body = (await this.#safeJson(response)) as {
      approvalId?: string;
      summary?: string;
      command?: string;
      expiresAt?: string;
      resourceId?: string | null;
    };

    if (!body.approvalId || !body.command) {
      return new ApiError(
        428,
        'CharityPilot asked for an approval but did not say which one. Nothing was changed.',
        { code: 'APPROVAL_REQUIRED' },
      );
    }

    return new ApprovalRequiredError({
      approvalId: body.approvalId,
      summary: body.summary ?? 'An action that cannot be undone',
      command: body.command,
      expiresAt: body.expiresAt ?? 'shortly',
      resourceId: typeof body.resourceId === 'string' ? body.resourceId : null,
    });
  }

  /**
   * An ApiError the agent can act on.
   *
   * Only codes the connector knows to be safe have their text quoted; every
   * other code is named and its text left where it was. Validation details
   * are always forwarded, because they describe the request rather than the
   * charity, and without them the model cannot correct itself.
   */
  async #refusal(response: Response): Promise<ApiError> {
    const body = (await this.#safeJson(response)) as {
      code?: unknown;
      error?: unknown;
      details?: unknown;
    };
    const code = typeof body.code === 'string' ? body.code : null;
    const details = code === 'VALIDATION_ERROR' ? validationDetails(body.details) : [];
    const retryAfterSeconds = retryAfterFrom(response);
    const guidance = guidanceFor(response.status, code, retryAfterSeconds);

    const head =
      code && isQuotable(code) && typeof body.error === 'string'
        ? `${body.error} (${code})`
        : code
          ? `CharityPilot refused the request (${code}).`
          : `CharityPilot returned ${response.status}.`;

    const lines = [head, ...details.map((d) => `- ${d.field}: ${d.message}`)];
    if (guidance.text) lines.push(guidance.text);

    return new ApiError(response.status, lines.join('\n'), {
      code,
      details,
      retryAfterSeconds,
      retryable: guidance.retryable,
      action: guidance.action,
    });
  }

  async #safeJson(response: Response): Promise<Record<string, unknown>> {
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
