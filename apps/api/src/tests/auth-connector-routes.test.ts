import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";

process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? "connector-routes-test-jwt-secret-value";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const { connectorAuthRoutes } = await import("../routes/auth/connector.js");
const { CONNECTOR_CLIENT_HEADER } = await import(
  "../utils/non-browser-client.js"
);
const { signAccessToken } = await import("../utils/jwt.js");
const { default: bcrypt } = await import("bcryptjs");

/** Records what the approve route tried to grant, and under what conditions. */
const approvalStore = {
  granted: [] as Array<Record<string, unknown>>,
  reset() {
    this.granted.length = 0;
  },
};

const REAL_PASSWORD = "a-real-password";
const PASSWORD_HASH = bcrypt.hashSync(REAL_PASSWORD, 4);

function connectorToken(userId = "usr-1"): string {
  return signAccessToken({
    userId,
    organisationId: "org-1",
    email: "owner@example.org",
    role: "OWNER",
    sessionId: "sess-1",
  } as never);
}

const { registerBrowserOriginProtection } = await import(
  "../plugins/browser-origin-protection.js"
);

const CLIENT = "mcp-connector/0.1.0";

type Recorded = {
  loginPosture?: unknown;
  refreshExpectedKind?: unknown;
};

function fakePrisma(recorded: Recorded) {
  // The service layer is exercised by its own tests; these routes are about
  // what reaches it and what comes back, so the boundary is stubbed here.
  return {
    __recorded: recorded,
    // Enough of the client for authGuard and the approve route. The service
    // layer has its own tests; these routes are about what reaches it.
    authSession: {
      findFirst: async () => ({
        id: "sess-1",
        clientKind: "MCP_CONNECTOR",
        accessLevel: "ADMIN",
      }),
    },
    user: {
      // Answers for whichever account the token names, so a test can act as a
      // second person in the same charity.
      findUnique: async ({ where }: { where: { id?: string } }) => ({
        id: where?.id ?? "usr-1",
        organisationId: "org-1",
        role: "OWNER",
        emailVerified: true,
        lifecycleStatus: "ACTIVE",
        organisation: { lifecycleStatus: "ACTIVE" },
        passwordHash: PASSWORD_HASH,
      }),
    },
    authActionApproval: {
      updateMany: async ({ where }: { where: Record<string, unknown> }) => {
        approvalStore.granted.push(where);
        return { count: 1 };
      },
      // Honours the where clause the routes actually send: the approve route
      // reads back by id alone, the preview route by id AND owner. Anything
      // that is not the one row this fake holds, or not this user's, is null.
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const mine =
          (where["userId"] === undefined || where["userId"] === "usr-1")
          && (where["organisationId"] === undefined || where["organisationId"] === "org-1")
          && (where["id"] === undefined || where["id"] === "apr-1");
        if (!mine) return null;
        return {
          id: "apr-1",
          summary: 'Permanently delete board member "Aoife Chairperson" (Chair)',
          method: "DELETE",
          routePattern: "/api/v1/board-members/:id",
          resourceId: "bm-1",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:05:00.000Z"),
          approvedAt: null,
          consumedAt: null,
        };
      },
    },
  };
}

async function buildApp(recorded: Recorded, behaviour: {
  login?: (data: unknown, posture: unknown) => Promise<unknown>;
  refresh?: (token: string, kind: unknown) => Promise<unknown>;
} = {}) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  approvalStore.reset();
  app.decorate("prisma", fakePrisma(recorded) as never);

  // Replace the service the routes construct, by intercepting at the module
  // boundary would be heavier than needed; instead the routes are registered
  // and the service methods are patched on the prototype.
  const { AuthService } = await import("../services/auth.service.js");
  const originalLogin = AuthService.prototype.login;
  const originalRefresh = AuthService.prototype.refresh;
  const originalLogout = AuthService.prototype.logout;

  AuthService.prototype.login = async function patchedLogin(data, posture) {
    recorded.loginPosture = posture;
    if (behaviour.login) return behaviour.login(data, posture) as never;
    return {
      user: {
        id: "usr-1",
        email: "owner@example.org",
        name: "Owner",
        role: "OWNER",
        organisationId: "org-1",
        emailVerified: true,
        organisation: {
          id: "org-1",
          name: "Probe Charity",
          rcnNumber: null,
          croNumber: null,
          legalForm: null,
          legalFormConfirmedAt: null,
          complexity: null,
          charitablePurpose: [],
          financialYearEnd: null,
          registeredAddress: null,
          contactEmail: null,
          contactPhone: null,
          website: null,
          dateRegistered: null,
          incorporationDate: null,
          croAnnualReturnDate: null,
          croAnnualReturnDateConfirmedAt: null,
          lastActualAgmDate: null,
          lastUnanimousAnnualMemberResolutionDate: null,
          memberCount: null,
          constitutionPermitsWrittenResolutions: null,
          conditionalObligationProfile: null,
          // publicOrganisation calls .toISOString() on this one without a guard.
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      },
      accessToken: "access-token-value",
      refreshToken: "refresh-token-value",
    } as never;
  };
  AuthService.prototype.refresh = async function patchedRefresh(token, kind) {
    recorded.refreshExpectedKind = kind;
    if (behaviour.refresh) return behaviour.refresh(token, kind) as never;
    return {
      accessToken: "next-access",
      refreshToken: "next-refresh",
    } as never;
  };
  AuthService.prototype.logout = async function patchedLogout() {
    return { message: "Signed out successfully." } as never;
  };

  await app.register(connectorAuthRoutes, { prefix: "/api/v1/auth/connector" });
  await app.ready();

  const restore = () => {
    AuthService.prototype.login = originalLogin;
    AuthService.prototype.refresh = originalRefresh;
    AuthService.prototype.logout = originalLogout;
  };
  return { app, restore };
}

function loginBody(overrides: Record<string, unknown> = {}) {
  return {
    email: "owner@example.org",
    password: "a-real-password",
    accessLevel: "READ",
    ...overrides,
  };
}

test("login returns tokens in the body and sets no cookie at all", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/connector/login",
      headers: { [CONNECTOR_CLIENT_HEADER]: CLIENT },
      payload: loginBody(),
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.accessToken, "access-token-value");
    assert.equal(body.refreshToken, "refresh-token-value");

    // The whole justification for waiving the origin requirement on these
    // routes is that a response setting no cookie cannot be login-CSRF'd.
    assert.equal(
      response.headers["set-cookie"],
      undefined,
      "a connector route must never set a cookie",
    );
  } finally {
    restore();
    await app.close();
  }
});

test("the route decides the client kind, whatever the body claims", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/connector/login",
      headers: { [CONNECTOR_CLIENT_HEADER]: CLIENT },
      payload: loginBody({ clientKind: "WEB", accessLevel: "READ" }),
    });

    assert.deepEqual(recorded.loginPosture, {
      clientKind: "MCP_CONNECTOR",
      accessLevel: "READ",
    });
  } finally {
    restore();
    await app.close();
  }
});

test("the access level reaches the session unchanged", async () => {
  for (const level of ["READ", "WRITE", "ADMIN"] as const) {
    const recorded: Recorded = {};
    const { app, restore } = await buildApp(recorded);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/connector/login",
        headers: { [CONNECTOR_CLIENT_HEADER]: CLIENT },
        payload: loginBody({ accessLevel: level }),
      });
      assert.equal(response.statusCode, 200);
      assert.equal(
        (recorded.loginPosture as { accessLevel: string }).accessLevel,
        level,
      );
      assert.equal(response.json().session.accessLevel, level);
    } finally {
      restore();
      await app.close();
    }
  }
});

test("an unknown access level is refused before any credential is read", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/connector/login",
      headers: { [CONNECTOR_CLIENT_HEADER]: CLIENT },
      payload: loginBody({ accessLevel: "SUPERUSER" }),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "VALIDATION_ERROR");
    assert.equal(recorded.loginPosture, undefined, "no credential was checked");
  } finally {
    restore();
    await app.close();
  }
});

test("a browser is turned away before any credential is read", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    const noHeader = await app.inject({
      method: "POST",
      url: "/api/v1/auth/connector/login",
      payload: loginBody(),
    });
    assert.equal(noHeader.statusCode, 403);
    assert.equal(noHeader.json().code, "BROWSER_CLIENT_REJECTED");

    const withOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/connector/login",
      headers: {
        [CONNECTOR_CLIENT_HEADER]: CLIENT,
        origin: "https://app.charitypilot.ie",
      },
      payload: loginBody(),
    });
    assert.equal(withOrigin.statusCode, 403);

    const withCookie = await app.inject({
      method: "POST",
      url: "/api/v1/auth/connector/login",
      headers: {
        [CONNECTOR_CLIENT_HEADER]: CLIENT,
        cookie: "charitypilot_access=someone-elses-session",
      },
      payload: loginBody(),
    });
    assert.equal(withCookie.statusCode, 403);

    assert.equal(
      recorded.loginPosture,
      undefined,
      "no credential may be looked at for a browser-shaped request",
    );
  } finally {
    restore();
    await app.close();
  }
});

test("refresh tells the service which channel the token must belong to", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/connector/refresh",
      headers: { [CONNECTOR_CLIENT_HEADER]: CLIENT },
      payload: { refreshToken: "some-token" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().accessToken, "next-access");
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(
      recorded.refreshExpectedKind,
      "MCP_CONNECTOR",
      "a web token must not be spendable here",
    );
  } finally {
    restore();
    await app.close();
  }
});

test("logout sets no cookie and does not require one", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/connector/logout",
      headers: { [CONNECTOR_CLIENT_HEADER]: CLIENT },
      payload: { refreshToken: "some-token" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, true);
    assert.equal(response.headers["set-cookie"], undefined);
  } finally {
    restore();
    await app.close();
  }
});

test("the client header is never added to the CORS allowed list", async () => {
  // This is what makes the routes unreachable from a page: the header is not
  // CORS-safelisted, so a browser must preflight it, and the preflight fails
  // because the header is not allowed. Adding it here would quietly undo the
  // entire design.
  const app = Fastify({ logger: false });
  await registerBrowserOriginProtection(
    app,
    new Set(["https://app.charitypilot.ie"]),
  );
  app.post("/probe", async () => ({ ok: true }));
  await app.ready();

  try {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/probe",
      headers: {
        origin: "https://app.charitypilot.ie",
        "access-control-request-method": "POST",
        "access-control-request-headers": CONNECTOR_CLIENT_HEADER,
      },
    });

    const allowed = String(
      preflight.headers["access-control-allow-headers"] ?? "",
    ).toLowerCase();
    assert.ok(
      !allowed.includes(CONNECTOR_CLIENT_HEADER),
      `the CORS allowed-header list must never include ${CONNECTOR_CLIENT_HEADER}`,
    );
  } finally {
    await app.close();
  }
});

test("each browser-only header is refused on its own, and Node's own fetch is not", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    for (const header of ["referer", "sec-fetch-site", "sec-fetch-dest"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/connector/login",
        headers: {
          [CONNECTOR_CLIENT_HEADER]: CLIENT,
          [header]: header === "referer" ? "https://app.charitypilot.ie/" : "same-origin",
        },
        payload: loginBody(),
      });
      assert.equal(response.statusCode, 403, `${header} is browser evidence`);
    }

    // Node's fetch sets this on every request it makes. Treating it as browser
    // evidence would refuse the connector along with the browser, which is
    // exactly the bug this asserts against.
    const nodeShaped = await app.inject({
      method: "POST",
      url: "/api/v1/auth/connector/login",
      headers: {
        [CONNECTOR_CLIENT_HEADER]: CLIENT,
        "sec-fetch-mode": "cors",
        "user-agent": "node",
        accept: "*/*",
      },
      payload: loginBody(),
    });
    assert.equal(
      nodeShaped.statusCode,
      200,
      "the connector's own request shape must be allowed through",
    );
  } finally {
    restore();
    await app.close();
  }
});

test("approving needs the right password, and says nothing more on failure", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/auth/connector/approve",
      headers: {
        [CONNECTOR_CLIENT_HEADER]: CLIENT,
        authorization: `Bearer ${connectorToken()}`,
      },
      payload: { approvalId: "apr-1", password: "not-the-password" },
    });

    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().code, "APPROVAL_REFUSED");
    assert.equal(
      approvalStore.granted.length,
      0,
      "a wrong password must grant nothing",
    );
  } finally {
    restore();
    await app.close();
  }
});

test("a browser cannot reach the approve route either", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/connector/approve",
      headers: {
        [CONNECTOR_CLIENT_HEADER]: CLIENT,
        authorization: `Bearer ${connectorToken()}`,
        origin: "https://app.charitypilot.ie",
      },
      payload: { approvalId: "apr-1", password: "a-real-password" },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "BROWSER_CLIENT_REJECTED");
  } finally {
    restore();
    await app.close();
  }
});

test("approving returns no token of any kind: it is not a sign-in", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/connector/approve",
      headers: {
        [CONNECTOR_CLIENT_HEADER]: CLIENT,
        authorization: `Bearer ${connectorToken()}`,
      },
      payload: { approvalId: "apr-1", password: "a-real-password" },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.accessToken, undefined);
    assert.equal(body.refreshToken, undefined);
    assert.equal(response.headers["set-cookie"], undefined);
  } finally {
    restore();
    await app.close();
  }
});

test("the grant narrows on every condition at once, so there is no window", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/connector/approve",
      headers: {
        [CONNECTOR_CLIENT_HEADER]: CLIENT,
        authorization: `Bearer ${connectorToken()}`,
      },
      payload: { approvalId: "apr-1", password: "a-real-password" },
    });

    const where = approvalStore.granted[0]!;
    assert.equal(where["id"], "apr-1");
    assert.equal(where["approvedAt"], null, "an already-granted approval is not re-granted");
    assert.equal(where["consumedAt"], null, "a spent approval cannot be revived");
    assert.ok(where["expiresAt"], "an expired approval cannot be granted");
    assert.ok(where["userId"], "someone else's approval is not grantable");
    assert.ok(where["organisationId"], "and not another charity's");
  } finally {
    restore();
    await app.close();
  }
});

test("a malformed body is refused before any password is compared", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/connector/approve",
      headers: {
        [CONNECTOR_CLIENT_HEADER]: CLIENT,
        authorization: `Bearer ${connectorToken()}`,
      },
      payload: { approvalId: "" },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "VALIDATION_ERROR");
  } finally {
    restore();
    await app.close();
  }
});

test("an approval can be read back by the person it belongs to, before they approve it", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/connector/approvals/apr-1",
      headers: {
        [CONNECTOR_CLIENT_HEADER]: CLIENT,
        authorization: `Bearer ${connectorToken()}`,
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.approvalId, "apr-1");
    assert.match(body.summary, /Aoife Chairperson/);
    assert.equal(body.resourceId, "bm-1");
    assert.equal(body.method, "DELETE");
    assert.equal(body.approvedAt, null);
    assert.equal(body.expiresAt, "2026-01-01T00:05:00.000Z");
  } finally {
    restore();
    await app.close();
  }
});

test("an approval that is not yours, or does not exist, reads as not found and says nothing more", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/connector/approvals/apr-someone-elses",
      headers: {
        [CONNECTOR_CLIENT_HEADER]: CLIENT,
        authorization: `Bearer ${connectorToken()}`,
      },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, "APPROVAL_NOT_FOUND");
    assert.equal(response.json().summary, undefined);
  } finally {
    restore();
    await app.close();
  }
});

test("a colleague cannot read an approval that is not theirs, even by its identifier", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/connector/approvals/apr-1",
      headers: {
        [CONNECTOR_CLIENT_HEADER]: CLIENT,
        authorization: `Bearer ${connectorToken("usr-2")}`,
      },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, "APPROVAL_NOT_FOUND");
  } finally {
    restore();
    await app.close();
  }
});

test("a browser cannot read an approval either", async () => {
  const recorded: Recorded = {};
  const { app, restore } = await buildApp(recorded);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/connector/approvals/apr-1",
      headers: {
        [CONNECTOR_CLIENT_HEADER]: CLIENT,
        authorization: `Bearer ${connectorToken()}`,
        origin: "https://app.example.org",
      },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "BROWSER_CLIENT_REJECTED");
  } finally {
    restore();
    await app.close();
  }
});
