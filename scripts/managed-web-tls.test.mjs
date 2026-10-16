import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:https";
import { parseManagedServiceImagePin } from "../packages/shared/runtime/managed-service-image-pin.mjs";
import { gatewayTlsFixture } from "./managed-gateway-tls-fixture.mjs";
import {
  createManagedWebHttpsServer,
  loadManagedWebTls,
} from "../apps/web/managed-tls.mjs";
import { createManagedWebBuildPin } from "../packages/shared/runtime/managed-web-build-pin.mjs";
test("legacy web image pins stay disabled and partial managed startup never falls back", () => {
  assert.deepEqual(createManagedWebBuildPin({}), {
    format: 1,
    sourceSha: null,
    bindingSha256: null,
  });
  assert.equal(loadManagedWebTls({}), null);
  assert.throws(() =>
    loadManagedWebTls({ CHARITYPILOT_MANAGED_PROVIDER: "render" }),
  );
  assert.throws(() =>
    createManagedWebBuildPin({
      NEXT_PUBLIC_CHARITYPILOT_MANAGED_WEB_BINDING_SHA256: "2".repeat(64),
      CHARITYPILOT_BUILD_COMMIT: "main",
    }),
  );
});
test("actual web TLS requires the pinned gateway and keeps forged service-role claims out of its handler", async () => {
  const f = gatewayTlsFixture(),
    r = f.binding.record;
  const env = {
    NODE_ENV: "production",
    PORT: "3003",
    CHARITYPILOT_MANAGED_PROVIDER: "render",
    CHARITYPILOT_MANAGED_WEB_BINDING: f.binding.json,
    CHARITYPILOT_BUILD_COMMIT: r.sourceSha,
    RENDER_SERVICE_TYPE: "pserv",
    RENDER_SERVICE_ID: r.webServiceId,
    NEXT_PUBLIC_CHARITYPILOT_DEPLOYMENT_MODE: "public-production",
    NEXT_PUBLIC_API_URL: r.publicOrigin,
    NEXT_PUBLIC_CHARITYPILOT_CANONICAL_API_ORIGIN: r.publicOrigin,
    NEXT_PUBLIC_CHARITYPILOT_MANAGED_WEB_BINDING_SHA256: f.binding.sha256,
    CHARITYPILOT_INTERNAL_API_URL: r.apiOrigin,
  };
  let reached = 0;
  const server = createManagedWebHttpsServer(
    env,
    { format: 1, sourceSha: r.sourceSha, bindingSha256: f.binding.sha256 },
    { issuerCertPem: f.issuer, certPem: f.web.cert, keyPem: f.web.key },
    (q, s) => {
      reached++;
      assert.equal(q.headers["x-charitypilot-peer-role"], undefined);
      s.end("synthetic-handler");
    },
  );
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const call = (peer) =>
      new Promise((resolve, reject) => {
        const q = request(
          {
            hostname: "127.0.0.1",
            port,
            servername: new URL(r.webOrigin).hostname,
            ca: f.issuer,
            cert: peer?.cert,
            key: peer?.key,
            agent: false,
            headers: {
              host: new URL(r.publicOrigin).host,
              "x-charitypilot-peer-role": "gateway",
            },
          },
          (s) => {
            s.resume();
            s.on("end", () => resolve(s.statusCode));
          },
        );
        q.on("error", reject);
        q.end();
      });
    assert.equal(await call(f.gateway), 200);
    await assert.rejects(call(undefined));
    assert.equal(await call(f.webClient), 403);
    assert.equal(reached, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    f.cleanup();
  }
});

test("immutable enabled image pins cannot become a disabled or noncanonical record", () => {
  const enabled = {
    format: 1,
    sourceSha: "1".repeat(40),
    bindingSha256: "2".repeat(64),
  };
  assert.deepEqual(
    parseManagedServiceImagePin(JSON.stringify(enabled) + "\n", true),
    enabled,
  );
  for (const raw of [
    JSON.stringify(enabled),
    JSON.stringify({ ...enabled, extra: true }) + "\n",
    JSON.stringify({ ...enabled, format: 2 }) + "\n",
    "null\n",
  ])
    assert.throws(() => parseManagedServiceImagePin(raw, true));
  const disabled =
    JSON.stringify({ format: 1, sourceSha: null, bindingSha256: null }) + "\n";
  assert.equal(parseManagedServiceImagePin(disabled), null);
  assert.throws(() => parseManagedServiceImagePin(disabled, true));
});
