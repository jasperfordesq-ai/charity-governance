import type { Session } from './session.js';
import { redactSecrets } from './redact.js';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(redactSecrets(message));
    this.name = 'ApiError';
    this.status = status;
  }
}

interface ApiClientOptions {
  session: Session;
  baseUrl: string;
  fetchImpl?: typeof fetch;
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

  async get<T>(path: string, isRetry = false): Promise<T> {
    const token = await this.#session.accessToken();

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
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
      return this.get<T>(path, true);
    }
    if (response.status === 401) {
      throw new ApiError(401, 'Session expired. Run: charitypilot-mcp connect');
    }
    if (!response.ok) {
      throw new ApiError(response.status, `CharityPilot returned ${response.status}.`);
    }

    return (await response.json()) as T;
  }
}
