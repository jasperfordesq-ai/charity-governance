import assert from "node:assert/strict";
import test from "node:test";

process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? "auth-refresh-channel-test-jwt-secret-value";
process.env.RESEND_API_KEY =
  process.env.RESEND_API_KEY ?? "re_auth_refresh_channel_test_key";
process.env.EMAIL_FROM = process.env.EMAIL_FROM ?? "noreply@example.org";

const [{ default: Fastify }, { default: cookie }, { authRoutes }, { AuthService }] =
  await Promise.all([
    import("fastify"),
    import("@fastify/cookie"),
    import("../routes/auth/index.js"),
    import("../services/auth.service.js"),
  ]);

/**
 * The browser refresh route sets cookies. If it accepted a token minted for the
 * connector, a credential lifted off a developer's machine would become an
 * ordinary browser session carried by a cookie the connector never had. The
 * connector route refuses a web token for the mirror-image reason, and this is
 * the half that guards the browser side.
 */
test("the browser refresh route tells the service the token must be a web one", async () => {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.decorate("prisma", {} as never);

  let seenKind: unknown = "never called";
  const original = AuthService.prototype.refresh;
  AuthService.prototype.refresh = async function patched(_token, kind) {
    seenKind = kind;
    return { accessToken: "a", refreshToken: "r" } as never;
  };

  await app.register(authRoutes, { prefix: "/auth" });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: "some-token" },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      seenKind,
      "WEB",
      "a connector token must not be spendable on the cookie-setting route",
    );
  } finally {
    AuthService.prototype.refresh = original;
    await app.close();
  }
});
