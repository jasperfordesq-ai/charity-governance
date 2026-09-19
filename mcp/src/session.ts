import type { CredentialStore } from './credentials.js';
import { registerSecret } from './redact.js';

const ACCESS_COOKIE = 'charitypilot_access';
const REFRESH_COOKIE = 'charitypilot_refresh';

export class NotConnectedError extends Error {
  readonly code = 'NOT_CONNECTED';
  constructor(message = 'Not connected. Run: charitypilot-mcp connect') {
    super(message);
    this.name = 'NotConnectedError';
  }
}

export interface SessionIdentity {
  email: string;
  name: string;
  role: string;
  organisationId: string;
  organisationName: string;
}

interface SessionOptions {
  baseUrl: string;
  store: CredentialStore;
  fetchImpl?: typeof fetch;
}

function readCookie(response: Response, name: string): string | null {
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(';');
    if (!pair) continue;
    const index = pair.indexOf('=');
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return null;
}

export class Session {
  readonly #baseUrl: string;
  readonly #origin: string;
  readonly #store: CredentialStore;
  readonly #fetch: typeof fetch;
  #accessToken: string | null = null;
  #identity: SessionIdentity | null = null;
  #refreshInFlight: Promise<string> | null = null;

  constructor(options: SessionOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    // The API's origin-validation hook (apps/api/src/utils/request-origin.ts)
    // treats /auth/login, /auth/refresh and /auth/logout as origin-sensitive
    // and 403s any request that arrives with no Origin header at all. This is
    // not a CORS nicety here — without it, every POST this class makes is
    // rejected before credentials are even checked.
    this.#origin = new URL(this.#baseUrl).origin;
    this.#store = options.store;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  identity(): SessionIdentity | null {
    return this.#identity;
  }

  async login(email: string, password: string): Promise<SessionIdentity> {
    const response = await this.#post('/api/v1/auth/login', { email, password });
    if (!response.ok) {
      throw new Error('Sign-in failed. Check the email address and password.');
    }
    const capturedRefreshToken = this.#absorbCookies(response);
    if (!capturedRefreshToken) {
      throw new Error(
        'Sign-in succeeded but CharityPilot did not return a refresh token, so nothing '
          + 'was stored. Run connect again — if this keeps happening, the connector is '
          + 'not talking to CharityPilot the way it expects to.',
      );
    }

    const body = (await response.json()) as {
      user: { email: string; name: string; role: string; organisationId: string;
              organisation?: { name?: string } | null };
    };
    this.#identity = {
      email: body.user.email,
      name: body.user.name,
      role: body.user.role,
      organisationId: body.user.organisationId,
      organisationName: body.user.organisation?.name ?? '(unnamed organisation)',
    };
    return this.#identity;
  }

  async accessToken(): Promise<string> {
    if (this.#accessToken) return this.#accessToken;
    if (this.#refreshInFlight) return this.#refreshInFlight;

    this.#refreshInFlight = this.#refreshAccessToken().finally(() => {
      this.#refreshInFlight = null;
    });
    return this.#refreshInFlight;
  }

  async #refreshAccessToken(): Promise<string> {
    const refreshToken = this.#store.read();
    if (!refreshToken) throw new NotConnectedError();

    const response = await this.#post('/api/v1/auth/refresh', { refreshToken });
    if (!response.ok) {
      // Only a 401 means the stored credential was actually rejected. A 403 here
      // says nothing about the credential's validity — the only reachable 403 on
      // this route is the request-origin hook's MISSING_ORIGIN rejection (see
      // request-origin.ts), which fires before the refresh token is even looked
      // at. Treating that the same as a dead credential would clear a perfectly
      // good refresh token because of a header problem. A 5xx or gateway error is
      // the same story: the server had a problem, and clearing here would turn a
      // transient blip into a permanent logout.
      if (response.status !== 401) {
        throw new Error(
          `Could not refresh the session: CharityPilot returned ${response.status}. `
            + 'The stored credential has been kept — try again.',
        );
      }
      try {
        this.#store.clear();
      } catch (cause) {
        throw new NotConnectedError(
          `Session ended, and the stored credential could not be removed: ${(cause as Error).message}`,
        );
      }
      this.#accessToken = null;
      this.#identity = null;
      throw new NotConnectedError('Session ended. Run: charitypilot-mcp connect');
    }
    this.#absorbCookies(response);

    if (!this.#accessToken) {
      try {
        this.#store.clear();
      } catch (cause) {
        throw new NotConnectedError(
          `Session ended, and the stored credential could not be removed: ${(cause as Error).message}`,
        );
      }
      throw new NotConnectedError('Session ended. Run: charitypilot-mcp connect');
    }
    return this.#accessToken;
  }

  /** Drop the cached access token so the next call refreshes. */
  invalidateAccessToken(): void {
    this.#accessToken = null;
  }

  async logout(): Promise<void> {
    const refreshToken = this.#store.read();
    if (refreshToken) {
      try {
        await this.#post('/api/v1/auth/logout', { refreshToken });
      } catch {
        // Revocation is best-effort; the local credential is cleared regardless.
      }
    }
    // Drop the in-memory session BEFORE clearing the store. `clear()` throws when the
    // OS credential store refuses to release the entry (locked keychain, permission
    // denied) — that throw must reach the user, because a disconnect that silently
    // leaves the credential on disk is worse than one that fails loudly. Clearing
    // memory first means the throw still leaves this process with no usable session.
    this.#accessToken = null;
    this.#identity = null;
    this.#store.clear();
  }

  /** Returns whether a refresh token cookie was found and stored. */
  #absorbCookies(response: Response): boolean {
    const access = readCookie(response, ACCESS_COOKIE);
    const refresh = readCookie(response, REFRESH_COOKIE);
    if (access) {
      this.#accessToken = access;
      registerSecret(access);
    }
    if (refresh) {
      this.#store.write(refresh);
      registerSecret(refresh);
      return true;
    }
    return false;
  }

  #post(path: string, body: unknown): Promise<Response> {
    return this.#fetch(`${this.#baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.#origin },
      body: JSON.stringify(body),
    });
  }
}
