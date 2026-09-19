import type { Session } from './session.js';
import { redactSecrets } from './redact.js';
import { CONNECTOR_VERSION } from './version.js';

const CLIENT_HEADER = 'x-charitypilot-client';
const REASON_HEADER = 'x-charitypilot-reason';
const APPROVAL_HEADER = 'x-charitypilot-approval';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(redactSecrets(message));
    this.name = 'ApiError';
    this.status = status;
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

  constructor(details: {
    approvalId: string;
    summary: string;
    command: string;
    expiresAt: string;
  }) {
    super(
      `${details.summary}\n\n`
        + 'CharityPilot will not do this until you approve it yourself. In your own '
        + `terminal, run:\n\n    ${details.command}\n\n`
        + 'You will be asked for your password there. Then ask me to try again. '
        + `The approval expires at ${details.expiresAt} and covers only this one action.`,
    );
    this.name = 'ApprovalRequiredError';
    this.approvalId = details.approvalId;
    this.summary = details.summary;
    this.command = details.command;
    this.expiresAt = details.expiresAt;
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
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

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

  post<T>(path: string, body: unknown, options: WriteOptions = {}): Promise<T> {
    return this.#request<T>('POST', path, body, options);
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
  ): Promise<{ bytes: Buffer; fileName: string | null }> {
    const token = await this.#session.accessToken();
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        [CLIENT_HEADER]: `mcp-connector/${CONNECTOR_VERSION}`,
      },
    });

    if (!response.ok) {
      throw new ApiError(response.status, await this.#refusalMessage(response));
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
    isRetry = false,
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

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
    } catch (cause) {
      throw new Error(
        redactSecrets(
          'Cannot reach CharityPilot. Check that Tailscale is connected. ' +
            `(${(cause as Error).message})`,
        ),
      );
    }

    // A 401 means the ~15-minute access token expired mid-session. The stored refresh
    // token is very likely still good, so drop the cached access token and retry ONCE.
    // Without this, every access-token expiry surfaces a spurious "reconnect" prompt
    // even though the next call would have succeeded — which defeats the whole point
    // of implementing refresh rotation. Bounded to one attempt so a genuinely dead
    // session still fails fast instead of looping.
    if (response.status === 401 && !isRetry) {
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
      return this.#send<T>(method, path, body, options, isJson, true);
    }
    if (response.status === 401) {
      throw new ApiError(401, 'Session expired. Run: charitypilot-mcp connect');
    }

    if (response.status === 428) {
      throw await this.#approvalRequired(response);
    }

    if (!response.ok) {
      throw new ApiError(response.status, await this.#refusalMessage(response));
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
    };

    if (!body.approvalId || !body.command) {
      return new ApiError(
        428,
        'CharityPilot asked for an approval but did not say which one. Nothing was changed.',
      );
    }

    return new ApprovalRequiredError({
      approvalId: body.approvalId,
      summary: body.summary ?? 'An action that cannot be undone',
      command: body.command,
      expiresAt: body.expiresAt ?? 'shortly',
    });
  }

  /**
   * A refusal message the person can act on, without echoing internals.
   *
   * Only the small set of codes this connector causes are quoted back, and
   * only their `error` text. Anything else keeps the bare status, because a
   * message chosen by the server for some other audience may carry detail
   * that has no business reaching a model.
   */
  async #refusalMessage(response: Response): Promise<string> {
    const body = (await this.#safeJson(response)) as {
      code?: unknown;
      error?: unknown;
    };
    const quotable = new Set([
      'SESSION_READ_ONLY',
      'SESSION_LEVEL_TOO_LOW',
      'CONNECTOR_WRITE_LIMIT',
      'BROWSER_CLIENT_REJECTED',
      'VALIDATION_ERROR',
    ]);

    if (
      typeof body.code === 'string'
      && quotable.has(body.code)
      && typeof body.error === 'string'
    ) {
      return `${body.error} (${body.code})`;
    }

    return `CharityPilot returned ${response.status}.`;
  }

  async #safeJson(response: Response): Promise<Record<string, unknown>> {
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
