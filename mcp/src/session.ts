import type { CredentialStore } from './credentials.js';
import type { AccessLevel } from './config.js';
import { registerSecret } from './redact.js';
import { CONNECTOR_VERSION } from './version.js';

/**
 * Identifies this as the connector rather than a browser.
 *
 * The API's connector routes require it, and it is not a header a web page
 * can send: it is not CORS-safelisted, so a browser must preflight it, and
 * the preflight is refused. That is what lets those routes hand back tokens
 * in the response body.
 */
const CLIENT_HEADER = 'x-charitypilot-client';

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
  accessLevel?: AccessLevel;
  fetchImpl?: typeof fetch;
}

interface ConnectorTokens {
  accessToken?: string;
  refreshToken?: string;
}

export class Session {
  readonly #baseUrl: string;
  readonly #accessLevel: AccessLevel;
  readonly #store: CredentialStore;
  readonly #fetch: typeof fetch;
  #accessToken: string | null = null;
  #identity: SessionIdentity | null = null;
  #refreshInFlight: Promise<string> | null = null;

  constructor(options: SessionOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    // Deliberately NO Origin header anywhere in this class. The connector auth
    // routes refuse any request carrying one, because an origin is evidence a
    // browser sent it and those routes return tokens in the response body.
    // Sending one would get every call rejected; not sending one is also what
    // makes a split-host deployment work, where the app and the API differ.
    this.#accessLevel = options.accessLevel ?? 'write';
    this.#store = options.store;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  identity(): SessionIdentity | null {
    return this.#identity;
  }

  async login(email: string, password: string): Promise<SessionIdentity> {
    const response = await this.#post('/api/v1/auth/connector/login', {
      email,
      password,
      accessLevel: this.#accessLevel.toUpperCase(),
    });
    if (!response.ok) {
      // A 403 here says nothing about whether the credentials are correct: it
      // is the API's non-browser guard refusing the request before any
      // credential is read. Reporting it as "check the email address and
      // password" would send someone back to retype an already-correct
      // password against a route that rate-limits per email address, and
      // repeated retries can lock out the real account. Every other status,
      // including 401, keeps the generic message: it must not leak whether the
      // email exists.
      if (response.status === 403) {
        throw new Error(
          'CharityPilot refused this request before checking the credentials. The '
            + 'connector sign-in route is reachable only by the connector, so this '
            + `usually means ${this.#baseUrl} is not a CharityPilot API, or it is `
            + 'running a build older than these routes.',
        );
      }
      if (response.status === 404) {
        throw new Error(
          `${this.#baseUrl} has no connector sign-in route. It is running a build `
            + 'older than this connector; deploy the API before connecting.',
        );
      }
      if (response.status === 429) {
        // Saying "check the email address and password" here is actively
        // harmful: the credentials were never looked at, the route limits
        // attempts per email address, and a person who retypes a correct
        // password in response spends the little budget that remains.
        throw new Error(
          'Too many sign-in attempts for this email address. Wait a minute and run '
            + 'connect again. The password was not checked, so nothing is wrong with it.',
        );
      }
      throw new Error('Sign-in failed. Check the email address and password.');
    }
    const payload = (await response.json()) as ConnectorTokens & {
      user: { email: string; name: string; role: string; organisationId: string;
              organisation?: { name?: string } | null };
    };
    const capturedRefreshToken = this.#absorbTokens(payload);
    if (!capturedRefreshToken) {
      throw new Error(
        'Sign-in succeeded but CharityPilot did not return a refresh token, so nothing '
          + 'was stored. Run connect again — if this keeps happening, the connector is '
          + 'not talking to CharityPilot the way it expects to.',
      );
    }

    this.#identity = {
      email: payload.user.email,
      name: payload.user.name,
      role: payload.user.role,
      organisationId: payload.user.organisationId,
      organisationName: payload.user.organisation?.name ?? '(unnamed organisation)',
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

    const response = await this.#post('/api/v1/auth/connector/refresh', { refreshToken });
    if (!response.ok) {
      // Only a 401 means the stored credential was actually rejected. A 403 here
      // says nothing about the credential's validity — it is the non-browser
      // guard refusing before the token is even looked at. Treating that the
      // same as a dead credential would clear a perfectly good refresh token
      // because of a header problem. A 5xx or gateway error is the same story:
      // the server had a problem, and clearing here would turn a transient blip
      // into a permanent logout.
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
    this.#absorbTokens((await response.json()) as ConnectorTokens);

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
    // A store bound to another origin throws rather than answering, and the
    // advice it gives is to disconnect. If disconnect were the one command that
    // could not run, the person would be stuck with a credential they cannot
    // remove. Revocation is skipped in that case; clearing is not.
    let refreshToken: string | null = null;
    try {
      refreshToken = this.#store.read();
    } catch {
      refreshToken = null;
    }
    if (refreshToken) {
      try {
        await this.#post('/api/v1/auth/connector/logout', { refreshToken });
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

  /**
   * Takes the tokens out of a connector-route response body and stores them.
   *
   * The browser routes set cookies; these do not, because the connector has no
   * cookie jar and a response that sets no cookie cannot be the target of
   * login cross-site request forgery. Returns whether a refresh token was
   * present, so a sign-in that stored nothing can be reported rather than
   * appearing to succeed.
   */
  #absorbTokens(payload: ConnectorTokens): boolean {
    const access = payload.accessToken;
    const refresh = payload.refreshToken;
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
      headers: {
        'content-type': 'application/json',
        [CLIENT_HEADER]: `mcp-connector/${CONNECTOR_VERSION}`,
      },
      body: JSON.stringify(body),
    });
  }
}
