import type { CredentialStore } from './credentials.js';
import type { AccessLevel, DataScope, Realm } from './config.js';
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
  /** Which credential realm this identity belongs to. */
  realm: Realm;
  email: string;
  name: string;
  /**
   * The charity role. Absent in the operator realm, which has no roles: an
   * operator is an operator. Optional rather than a placeholder string, so a
   * caller that prints it has to decide what to print when there is none.
   */
  role?: string;
  /** Absent in the operator realm, which belongs to no organisation. */
  organisationId?: string;
  organisationName?: string;
  /** Operator realm only: whether the account's second factor is enrolled. */
  secondFactorEnrolled?: boolean;
}

/**
 * Where each realm's connector routes live.
 *
 * The two sets are deliberately identical in shape. They differ in prefix and
 * in what the login body carries, and in nothing else, so the token engine
 * below does not branch on the realm at all.
 */
const REALM_PREFIX: Record<Realm, string> = {
  charity: '/api/v1/auth/connector',
  operator: '/api/v1/owner/auth/connector',
};

/** One approval as the API describes it, for a person to read before granting it. */
export interface ApprovalPreview {
  approvalId: string;
  summary: string;
  method: string;
  routePattern: string;
  resourceId: string | null;
  expiresAt: string;
  approvedAt: string | null;
  consumedAt: string | null;
}

interface SessionOptions {
  baseUrl: string;
  store: CredentialStore;
  accessLevel?: AccessLevel;
  dataScope?: DataScope;
  fetchImpl?: typeof fetch;
  realm?: Realm;
  /** Operator realm only: the authenticator code, typed once at connect. */
  code?: string | undefined;
  /** Operator realm only: a recovery code, when the authenticator is gone. */
  recoveryCode?: string | undefined;
}

interface ConnectorTokens {
  accessToken?: string;
  refreshToken?: string;
}

export class Session {
  readonly #baseUrl: string;
  readonly #accessLevel: AccessLevel;
  readonly #dataScope: DataScope;
  readonly #store: CredentialStore;
  readonly #fetch: typeof fetch;
  readonly #realm: Realm;
  readonly #prefix: string;
  readonly #code: string | undefined;
  readonly #recoveryCode: string | undefined;
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
    this.#dataScope = options.dataScope ?? 'withheld';
    this.#store = options.store;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#realm = options.realm ?? 'charity';
    this.#prefix = REALM_PREFIX[this.#realm];
    this.#code = options.code;
    this.#recoveryCode = options.recoveryCode;
  }

  realm(): Realm {
    return this.#realm;
  }

  identity(): SessionIdentity | null {
    return this.#identity;
  }

  async login(email: string, password: string): Promise<SessionIdentity> {
    const response = await this.#post(`${this.#prefix}/login`, {
      email,
      password,
      accessLevel: this.#accessLevel.toUpperCase(),
      // The two realms differ here and nowhere else in this class. The
      // operator realm has no data scope because it has no personal data to
      // scope, and it requires the second factor because a credential an
      // agent holds, which can close a charity, may not rest on a password.
      ...(this.#realm === 'operator'
        ? {
            ...(this.#code ? { code: this.#code } : {}),
            ...(this.#recoveryCode ? { recoveryCode: this.#recoveryCode } : {}),
          }
        : { dataScope: this.#dataScope.toUpperCase() }),
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
        // Two different refusals share this status. One happens before any
        // credential is read, and says nothing about the account; the other
        // happens after the password, and is the API declining to issue a
        // session that wide to this role. Reporting the second as the first
        // would send somebody looking for a broken host.
        let body: { code?: unknown; error?: unknown } = {};
        try {
          body = (await response.json()) as { code?: unknown; error?: unknown };
        } catch {
          body = {};
        }
        if (body.code === 'DATA_SCOPE_FORBIDDEN' && typeof body.error === 'string') {
          throw new Error(body.error);
        }
        // The operator realm's own after-the-password refusal: the account has
        // no authenticator, and a connector session may not rest on a password
        // alone. Reporting it as a broken host would send somebody looking in
        // entirely the wrong place for a message that already says what to do.
        if (body.code === 'OPERATOR_SECOND_FACTOR_REQUIRED' && typeof body.error === 'string') {
          throw new Error(body.error);
        }
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
      // A 401 is normally "wrong email or password", and must stay that vague:
      // saying which was wrong tells an attacker which addresses exist. The
      // operator realm's second factor is the exception, because there the
      // password WAS right, and the generic message sends somebody to retype a
      // correct password against a route that limits attempts per address —
      // spending the budget that remains on the one thing that is not wrong.
      //
      // Found by the live suite. The unit tests all stub the boundary this
      // crosses, so every one of them was green while `connect --realm
      // operator --code <wrong>` reported a bad password.
      if (response.status === 401) {
        let body: { code?: unknown; error?: unknown } = {};
        try {
          body = (await response.json()) as { code?: unknown; error?: unknown };
        } catch {
          body = {};
        }
        if (body.code === 'SECOND_FACTOR_REQUIRED' && typeof body.error === 'string') {
          throw new Error(body.error);
        }
      }
      throw new Error('Sign-in failed. Check the email address and password.');
    }
    const payload = (await response.json()) as ConnectorTokens & {
      user?: { email: string; name: string; role: string; organisationId: string;
               organisation?: { name?: string } | null };
      operator?: { id: string; email: string; name: string };
    };
    const capturedRefreshToken = this.#absorbTokens(payload);
    if (!capturedRefreshToken) {
      throw new Error(
        'Sign-in succeeded but CharityPilot did not return a refresh token, so nothing '
          + 'was stored. Run connect again — if this keeps happening, the connector is '
          + 'not talking to CharityPilot the way it expects to.',
      );
    }

    if (this.#realm === 'operator') {
      const operator = payload.operator;
      if (!operator) {
        throw new Error(
          'Sign-in succeeded but CharityPilot did not say who was signed in. The '
            + 'connector is not talking to the operator realm the way it expects to.',
        );
      }
      // No role and no organisation, because an operator has neither. The
      // absent fields are the shape of the realm, not missing data.
      this.#identity = {
        realm: 'operator',
        email: operator.email,
        name: operator.name,
        secondFactorEnrolled: true,
      };
      return this.#identity;
    }

    const user = payload.user;
    if (!user) {
      throw new Error(
        'Sign-in succeeded but CharityPilot did not say who was signed in. Run '
          + 'connect again — if this keeps happening, the connector is not talking '
          + 'to CharityPilot the way it expects to.',
      );
    }

    this.#identity = {
      realm: 'charity',
      email: user.email,
      name: user.name,
      role: user.role,
      organisationId: user.organisationId,
      organisationName: user.organisation?.name ?? '(unnamed organisation)',
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

    const response = await this.#post(`${this.#prefix}/refresh`, { refreshToken });
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

  /**
   * Grants one pending approval, with the password of the person at the
   * keyboard.
   *
   * Uses the session's own access token rather than signing in again: the
   * person approving is the person already connected, and minting a second
   * session to approve an action in the first would be a new credential for no
   * reason.
   */
  async approve(
    approvalId: string,
    password: string,
  ): Promise<{ summary: string | null; expiresAt: string | null }> {
    const accessToken = await this.accessToken();
    const response = await this.#fetch(
      `${this.#baseUrl}${this.#prefix}/approve`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
          [CLIENT_HEADER]: `mcp-connector/${CONNECTOR_VERSION}`,
        },
        body: JSON.stringify({ approvalId, password }),
      },
    );

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error(
          'Too many approval attempts. Wait a minute and try again; the password was '
            + 'not checked, so nothing is wrong with it.',
        );
      }
      // The API answers every failure identically on purpose, so that a caller
      // cannot learn which of the conditions was the one that failed.
      throw new Error(
        'That approval could not be granted. Check the password, and that the '
          + 'identifier is the one just printed and has not expired.',
      );
    }

    const payload = (await response.json()) as {
      summary?: string | null;
      expiresAt?: string | null;
    };
    return {
      summary: payload.summary ?? null,
      expiresAt: payload.expiresAt ?? null,
    };
  }

  /**
   * Reads an approval back so it can be shown before the password is asked
   * for. Refuses, rather than proceeding blind, when the API cannot describe
   * it: an approval nobody has read is an approval taken on the agent's word.
   */
  async describeApproval(approvalId: string): Promise<ApprovalPreview> {
    const accessToken = await this.accessToken();
    const response = await this.#fetch(
      `${this.#baseUrl}${this.#prefix}/approvals/${encodeURIComponent(approvalId)}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          [CLIENT_HEADER]: `mcp-connector/${CONNECTOR_VERSION}`,
        },
      },
    );

    if (response.status === 404) {
      let body: { code?: unknown } = {};
      try {
        body = (await response.json()) as { code?: unknown };
      } catch {
        body = {};
      }
      if (body.code === 'APPROVAL_NOT_FOUND') {
        throw new Error(
          'No pending approval with that identifier belongs to you. Check it against what '
            + 'the assistant printed; approvals expire five minutes after they are asked for. '
            + 'Nothing was approved.',
        );
      }
      throw new Error(
        `${this.#baseUrl} cannot describe approvals: it is running a build older than this `
          + 'connector. Nothing was approved. Deploy the API before approving from here.',
      );
    }
    if (!response.ok) {
      throw new Error(
        `Could not read the approval: CharityPilot returned ${response.status}. Nothing was approved.`,
      );
    }

    const body = (await response.json()) as Partial<ApprovalPreview>;
    if (typeof body.approvalId !== 'string' || typeof body.summary !== 'string') {
      throw new Error(
        'CharityPilot described the approval in a form this connector does not understand. '
          + 'Nothing was approved.',
      );
    }
    return {
      approvalId: body.approvalId,
      summary: body.summary,
      method: typeof body.method === 'string' ? body.method : '?',
      routePattern: typeof body.routePattern === 'string' ? body.routePattern : '?',
      resourceId: typeof body.resourceId === 'string' ? body.resourceId : null,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : 'unknown',
      approvedAt: typeof body.approvedAt === 'string' ? body.approvedAt : null,
      consumedAt: typeof body.consumedAt === 'string' ? body.consumedAt : null,
    };
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
        await this.#post(`${this.#prefix}/logout`, { refreshToken });
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
