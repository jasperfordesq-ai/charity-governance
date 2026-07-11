import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LOCAL_CONTRACT,
  ROOT,
  COMPOSE_FILE,
  BUILD_CONTEXT_MANIFEST,
  assertNoDockerEndpointOverrides,
  assertStandaloneComposeSource,
  ambientSecretCandidates,
  assertLoopbackPortsAvailable,
  createLocalRunIdentity,
  createIsolatedBuildContext,
  composeInvocation,
  captureBuiltImageAttestation,
  captureRunningContainerAttestation,
  checkedWindowsTaskkill,
  createCommandRunner,
  expectedLocalServiceEnvironments,
  parseRunnerArgs,
  janitorRemoteDisposableDatabase,
  isExactPosixChildGroupAbsent,
  redactSecrets,
  resolveOverallRunnerTimeoutMs,
  runIsolatedE2e,
  serializeEnvFile,
  stopAndWaitForExactChildTree,
  validateRenderedCompose,
  verifyApiDatabaseBinding,
  validateLocalDockerEndpoint,
  verifyIntegratedLocalBuilder,
  verifyLocalDockerContext,
  waitForEndpoint,
} from "./run-isolated-e2e.mjs";

const FIXED_IDENTITY = createLocalRunIdentity({
  instanceId: "9d9899dc-9bea-45ca-a916-c9a2e023e46e",
  bootstrapPassword: "bootstrap-password-unique-value",
  runnerPassword: "runner-password-unique-value",
  jwtSecret: "jwt-secret-unique-value-with-enough-entropy",
  readinessKey: "readiness-key-unique-value-with-entropy",
});

const FIXED_HEALTHCHECKS = {
  api: {
    test: [
      "CMD-SHELL",
      "node -e \"fetch('http://127.0.0.1:3302/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\"",
    ],
    interval: "3s",
    timeout: "5s",
    retries: 80,
    start_period: "20s",
  },
  db: {
    test: [
      "CMD-SHELL",
      "PGPASSWORD=$$E2E_DATABASE_RUNNER_PASSWORD pg_isready -U charitypilot_e2e_runner -d charitypilot_e2e_disposable",
    ],
    interval: "2s",
    timeout: "3s",
    retries: 45,
    start_period: "5s",
  },
  gateway: {
    test: [
      "CMD",
      "node",
      "-e",
      "const fs=require('node:fs');const listeners=new Set(fs.readFileSync('/proc/net/tcp','utf8').trim().split('\\n').slice(1).filter(line=>line.trim().split(/\\s+/)[3]==='0A').map(line=>line.trim().split(/\\s+/)[1]));process.exit(['00000000:D88A','00000000:0CE6','00000000:0CE7'].every(listener=>listeners.has(listener))?0:1)",
    ],
    interval: "3s",
    timeout: "3s",
    retries: 10,
    start_period: "2s",
  },
  web: {
    test: [
      "CMD-SHELL",
      "node -e \"fetch('http://127.0.0.1:3303/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\"",
    ],
    interval: "3s",
    timeout: "5s",
    retries: 80,
    start_period: "30s",
  },
};

const FIXED_TMPFS = {
  api: [
    "/var/lib/charitypilot-e2e-documents:rw,nosuid,nodev,noexec,size=256m,mode=0700,uid=1000,gid=1000",
    "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
  ],
  db: [
    "/var/lib/postgresql/data:rw,nosuid,nodev,size=1024m,mode=0700",
    "/var/run/postgresql:rw,nosuid,nodev,noexec,size=16m,mode=0775",
    "/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777",
  ],
  web: ["/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777"],
};

const TEST_RUNTIME_ATTESTATION_STUBS = Object.freeze({
  captureBuiltImageAttestation: async () => ({
    synthetic: "built-images-attested",
  }),
  captureRunningContainerAttestation: async () => ({
    synthetic: "containers-attested",
  }),
});

async function runIsolatedE2eForPlatformTest(platform, argv, options) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(descriptor?.configurable, "process.platform must be restorable");
  Object.defineProperty(process, "platform", {
    ...descriptor,
    value: platform,
  });
  try {
    return await runIsolatedE2e(argv, options);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

function appRuntime(projectName, serviceName) {
  return {
    image: `${projectName}-app:local`,
    user: "1000:1000",
    read_only: true,
    init: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    networks: { e2e: { aliases: [`${serviceName}.charitypilot-e2e.invalid`] } },
  };
}

function renderedCompose(projectName = FIXED_IDENTITY.projectName) {
  const environments = expectedLocalServiceEnvironments(FIXED_IDENTITY);
  return {
    name: projectName,
    services: {
      api: {
        ...appRuntime(projectName, "api"),
        build: {
          context: FIXED_IDENTITY.buildContextPath,
          dockerfile: "e2e/docker/Dockerfile",
          target: "app",
        },
        command: [
          "sh",
          "-lc",
          "set -eu\n" +
            "./node_modules/.bin/prisma migrate deploy --schema apps/api/prisma/schema.prisma\n" +
            "./node_modules/.bin/tsx apps/api/prisma/seed.ts\n" +
            "exec node --import tsx apps/api/src/server.ts\n",
        ],
        depends_on: { db: { condition: "service_healthy", required: true } },
        entrypoint: null,
        environment: environments.api,
        healthcheck: structuredClone(FIXED_HEALTHCHECKS.api),
        tmpfs: [...FIXED_TMPFS.api],
      },
      db: {
        image: `${projectName}-database:local`,
        build: {
          context: FIXED_IDENTITY.buildContextPath,
          dockerfile: "e2e/docker/Dockerfile",
          target: "database",
        },
        command: null,
        entrypoint: null,
        environment: environments.db,
        healthcheck: structuredClone(FIXED_HEALTHCHECKS.db),
        networks: { e2e: { aliases: ["db.charitypilot-e2e.invalid"] } },
        read_only: true,
        stop_grace_period: "15s",
        tmpfs: [...FIXED_TMPFS.db],
      },
      web: {
        ...appRuntime(projectName, "web"),
        command: ["node", "apps/web/server.mjs"],
        depends_on: { api: { condition: "service_healthy", required: true } },
        entrypoint: null,
        environment: environments.web,
        healthcheck: structuredClone(FIXED_HEALTHCHECKS.web),
        tmpfs: [...FIXED_TMPFS.web],
      },
      gateway: {
        image: `${projectName}-gateway:local`,
        build: {
          context: FIXED_IDENTITY.buildContextPath,
          dockerfile: "e2e/docker/Dockerfile",
          target: "gateway",
        },
        cap_drop: ["ALL"],
        command: ["/gateway/tcp-gateway.mjs"],
        depends_on: {
          api: { condition: "service_healthy", required: true },
          db: { condition: "service_healthy", required: true },
          web: { condition: "service_healthy", required: true },
        },
        entrypoint: ["node"],
        healthcheck: structuredClone(FIXED_HEALTHCHECKS.gateway),
        init: true,
        networks: { e2e: null, edge: null },
        ports: [
          {
            target: 55434,
            published: "55434",
            host_ip: "127.0.0.1",
            protocol: "tcp",
            mode: "ingress",
          },
          {
            target: 3302,
            published: "3302",
            host_ip: "127.0.0.1",
            protocol: "tcp",
            mode: "ingress",
          },
          {
            target: 3303,
            published: "3303",
            host_ip: "127.0.0.1",
            protocol: "tcp",
            mode: "ingress",
          },
        ],
        read_only: true,
        security_opt: ["no-new-privileges:true"],
        stop_grace_period: "10s",
        user: "1000:1000",
      },
    },
    networks: {
      e2e: {
        name: `${projectName}_e2e`,
        driver: "bridge",
        internal: true,
        ipam: {},
      },
      edge: { name: `${projectName}_edge`, driver: "bridge", ipam: {} },
    },
  };
}

function validateCompose(model) {
  return validateRenderedCompose(
    model,
    FIXED_IDENTITY.projectName,
    ROOT,
    FIXED_IDENTITY.buildContextPath,
    FIXED_IDENTITY,
  );
}

test("local run identity pins the disposable contract and creates no reusable credential defaults", () => {
  const identity = FIXED_IDENTITY;

  assert.equal(identity.projectName, "charitypilot-e2e-9d9899dc9bea45caa916");
  assert.equal(identity.playwrightEnv.E2E_EXECUTION_MODE, "local-disposable");
  assert.equal(
    identity.playwrightEnv.E2E_DESTRUCTIVE_RESET_CONFIRMATION,
    "DELETE_ONLY_CHARITYPILOT_DISPOSABLE_E2E",
  );
  assert.equal(
    identity.playwrightEnv.E2E_DATABASE_INSTANCE_ID,
    identity.instanceId,
  );
  assert.equal(identity.playwrightEnv.E2E_WEB_URL, "http://127.0.0.1:3303");
  assert.equal(identity.playwrightEnv.E2E_API_URL, "http://127.0.0.1:3302");
  assert.equal(
    identity.playwrightEnv.E2E_READINESS_API_KEY,
    identity.readinessKey,
  );
  assert.equal(identity.playwrightEnv.E2E_JWT_SECRET, identity.jwtSecret);
  assert.equal(identity.appImage, `${identity.projectName}-app:local`);
  assert.equal(
    identity.databaseImage,
    `${identity.projectName}-database:local`,
  );
  assert.equal(identity.gatewayImage, `${identity.projectName}-gateway:local`);
  assert.equal(identity.composeEnv.E2E_APP_IMAGE, identity.appImage);
  assert.equal(identity.composeEnv.E2E_DATABASE_IMAGE, identity.databaseImage);
  assert.equal(identity.composeEnv.E2E_GATEWAY_IMAGE, identity.gatewayImage);
  assert.match(
    identity.databaseUrl,
    /^postgresql:\/\/charitypilot_e2e_runner:/,
  );
  assert.match(
    identity.databaseUrl,
    /@127\.0\.0\.1:55434\/charitypilot_e2e_disposable\?/,
  );
  assert.match(identity.databaseUrl, /schema=public/);
  assert.match(identity.databaseUrl, /application_name=charitypilot-e2e-reset/);
  assert.equal(
    LOCAL_CONTRACT.databaseComment,
    "CHARITYPILOT_DISPOSABLE_E2E_DATABASE_V1",
  );
});

test("runner arguments reserve runner options and pass Playwright arguments through exactly", () => {
  assert.deepEqual(
    parseRunnerArgs([
      "--validate-only",
      "--",
      "tests/auth.spec.ts",
      "--grep",
      "login",
    ]),
    {
      validateOnly: true,
      playwrightArgs: ["tests/auth.spec.ts", "--grep", "login"],
    },
  );
  assert.throws(
    () => parseRunnerArgs(["--runner-unknown"]),
    /Unknown isolated E2E runner option/,
  );
});

test("every runner mode has a bounded default deadline and rejects malformed explicit timeouts", () => {
  assert.equal(resolveOverallRunnerTimeoutMs({}), 2_400_000);
  assert.equal(
    resolveOverallRunnerTimeoutMs({ E2E_RUNNER_TIMEOUT_MS: "3600000" }),
    3_600_000,
  );
  assert.equal(resolveOverallRunnerTimeoutMs({}, 5_000), 5_000);
  for (const raw of [
    "",
    "0",
    "-1",
    "1.5",
    " 2400000 ",
    "7200001",
    "not-a-number",
  ]) {
    assert.throws(
      () => resolveOverallRunnerTimeoutMs({ E2E_RUNNER_TIMEOUT_MS: raw }),
      /E2E_RUNNER_TIMEOUT_MS/,
    );
  }
  for (const value of [0, -1, 7_200_001, Number.NaN, 1.5]) {
    assert.throws(
      () => resolveOverallRunnerTimeoutMs({}, value),
      /overallTimeoutMs/,
    );
  }
});

test("positive build-context copier admits only manifest files and approved source extensions", async () => {
  const scratch = await mkdtemp(
    join(tmpdir(), "charitypilot-e2e-context-test-"),
  );
  const source = join(scratch, "source");
  const destination = join(scratch, "destination");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "package.json"), '{"private":true}\n');
  await writeFile(
    join(source, "src", "safe.ts"),
    "export const safe = true;\n",
  );
  await writeFile(
    join(source, "src", "private.txt"),
    "must never enter context\n",
  );
  const manifest = [
    { path: "package.json", type: "file" },
    { path: "src", type: "directory", allowedExtensions: [".ts"] },
  ];

  try {
    await assert.rejects(
      createIsolatedBuildContext(source, destination, manifest),
      /unapproved extension/,
    );
    assert.equal(
      existsSync(destination),
      false,
      "failed context copy must clean its partial directory",
    );

    await rm(join(source, "src", "private.txt"));
    await createIsolatedBuildContext(source, destination, manifest);
    assert.equal(existsSync(join(destination, "package.json")), true);
    assert.equal(existsSync(join(destination, "src", "safe.ts")), true);
    assert.equal(existsSync(join(destination, "src", "private.txt")), false);
    await rm(destination, { recursive: true, force: true });

    await writeFile(join(source, "src", ".env.secret"), "forbidden\n");
    await assert.rejects(
      createIsolatedBuildContext(source, destination, manifest),
      /Hidden or environment files/,
    );
    await assert.rejects(
      createIsolatedBuildContext(source, destination, [
        { path: "../escape", type: "file" },
      ]),
      /Unsafe isolated build-context manifest path/,
    );

    await rm(join(source, "src", ".env.secret"));
    const outsideSecret = join(source, "outside-secret.ts");
    await writeFile(
      outsideSecret,
      "must never enter context through a hard link\n",
    );
    await link(outsideSecret, join(source, "src", "hard-linked.ts"));
    await assert.rejects(
      createIsolatedBuildContext(source, destination, manifest),
      /Hard-linked files are forbidden/,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  assert.deepEqual(
    BUILD_CONTEXT_MANIFEST.filter((entry) => entry.type === "directory").map(
      (entry) => entry.path,
    ),
    [
      "apps/api/src",
      "apps/api/prisma",
      "apps/web/src",
      "apps/web/public",
      "packages/shared/src",
    ],
  );
  assert.ok(
    BUILD_CONTEXT_MANIFEST.some(
      (entry) =>
        entry.path === "e2e/docker/tcp-gateway.mjs" && entry.type === "file",
    ),
    "the audited gateway source must be copied as one exact manifest file",
  );
  for (const path of [
    "apps/web/server.mjs",
    "scripts/clean-next-export.cjs",
    "scripts/next-build-fs-retry.cjs",
  ]) {
    assert.ok(
      BUILD_CONTEXT_MANIFEST.some(
        (entry) => entry.path === path && entry.type === "file",
      ),
      `${path} must be copied as one exact manifest file for the baked web build`,
    );
  }
});

test("env serialization rejects injection and secret redaction covers DSNs and raw generated values", () => {
  assert.equal(
    serializeEnvFile({ SAFE_VALUE: "abc_123-DEF" }),
    "SAFE_VALUE=abc_123-DEF\n",
  );
  assert.throws(
    () => serializeEnvFile({ SAFE_VALUE: "abc\nINJECTED=true" }),
    /not env-file safe/,
  );

  const text = `password=${FIXED_IDENTITY.runnerPassword} dsn=${FIXED_IDENTITY.databaseUrl}`;
  const redacted = redactSecrets(text, FIXED_IDENTITY.secrets);
  assert.doesNotMatch(redacted, /runner-password-unique-value/);
  assert.doesNotMatch(redacted, /postgresql:\/\/charitypilot_e2e_runner:[^[]/);
  assert.match(redacted, /\[REDACTED\]/);

  const ambient = ambientSecretCandidates({
    E2E_DATABASE_URL:
      "postgresql://runner:encoded%2Dpassword@qa.example.test:5432/db",
    E2E_OWNER_EMAIL: "qa-owner@example.test",
    E2E_OWNER_PASSWORD: "owner-password-secret",
  });
  assert.ok(ambient.includes("encoded-password"));
  assert.ok(ambient.includes("qa-owner@example.test"));
  assert.ok(ambient.includes("owner-password-secret"));
});

test("rendered compose validation accepts only loopback, tmpfs and project-scoped writable paths", () => {
  const model = renderedCompose();
  assert.equal(validateCompose(model), true);

  const wrongProject = structuredClone(model);
  wrongProject.name = "charitypilot-e2e-other";
  assert.throws(() => validateCompose(wrongProject), /project name/);

  const publicGateway = structuredClone(model);
  publicGateway.services.gateway.ports[0].host_ip = "0.0.0.0";
  assert.throws(
    () => validateCompose(publicGateway),
    /exact audited TCP routes on 127\.0\.0\.1/,
  );

  const hostMount = structuredClone(model);
  hostMount.services.api.volumes = [
    { type: "bind", source: ROOT, target: "/app", read_only: true },
  ];
  assert.throws(
    () => validateCompose(hostMount),
    /must not mount any host path/,
  );

  const writableRoot = structuredClone(model);
  writableRoot.services.api.read_only = false;
  assert.throws(() => validateCompose(writableRoot), /read-only root/);

  for (const serviceName of ["api", "db", "gateway", "web"]) {
    const changedHealthInterval = structuredClone(model);
    changedHealthInterval.services[serviceName].healthcheck.interval = "1h";
    assert.throws(
      () => validateCompose(changedHealthInterval),
      /exact bounded healthcheck/,
      `${serviceName} health interval`,
    );

    const changedHealthCommand = structuredClone(model);
    changedHealthCommand.services[serviceName].healthcheck.test = [
      "CMD",
      "true",
    ];
    assert.throws(
      () => validateCompose(changedHealthCommand),
      /exact bounded healthcheck/,
      `${serviceName} health command`,
    );

    const extraHealthField = structuredClone(model);
    extraHealthField.services[serviceName].healthcheck.disable = true;
    assert.throws(
      () => validateCompose(extraHealthField),
      /healthcheck contains an unexpected or missing field/,
      `${serviceName} health extra field`,
    );
  }

  for (const serviceName of ["api", "db", "web"]) {
    const changedTmpfs = structuredClone(model);
    changedTmpfs.services[serviceName].tmpfs[0] = changedTmpfs.services[
      serviceName
    ].tmpfs[0].replace(/size=\d+m/u, "size=1m");
    assert.throws(
      () => validateCompose(changedTmpfs),
      /exact isolated tmpfs contract/,
      `${serviceName} tmpfs options`,
    );

    const extraTmpfs = structuredClone(model);
    extraTmpfs.services[serviceName].tmpfs.push("/attacker:rw,size=1m");
    assert.throws(
      () => validateCompose(extraTmpfs),
      /exact isolated tmpfs contract/,
      `${serviceName} extra tmpfs`,
    );
  }

  const gatewayTmpfs = structuredClone(model);
  gatewayTmpfs.services.gateway.tmpfs = ["/tmp:rw,size=1m"];
  assert.throws(
    () => validateCompose(gatewayTmpfs),
    /exact isolated tmpfs contract|unexpected or missing field/,
  );

  for (const [serviceName, value] of [
    ["db", "1h"],
    ["gateway", "0s"],
  ]) {
    const changedStopGrace = structuredClone(model);
    changedStopGrace.services[serviceName].stop_grace_period = value;
    assert.throws(
      () => validateCompose(changedStopGrace),
      /exact bounded stop grace period/,
      `${serviceName} stop grace`,
    );
  }

  const sharedImage = structuredClone(model);
  sharedImage.services.web.image = "charitypilot-web:latest";
  assert.throws(() => validateCompose(sharedImage), /runner-scoped/);

  const sharedGatewayImage = structuredClone(model);
  sharedGatewayImage.services.gateway.image = "shared-gateway:latest";
  assert.throws(() => validateCompose(sharedGatewayImage), /runner-scoped/);

  const wrongGatewayTarget = structuredClone(model);
  wrongGatewayTarget.services.gateway.build.target = "app";
  assert.throws(
    () => validateCompose(wrongGatewayTarget),
    /audited build targets/,
  );

  const extraPort = structuredClone(model);
  extraPort.services.gateway.ports.push({
    target: 9999,
    published: "9999",
    host_ip: "127.0.0.1",
    protocol: "tcp",
    mode: "ingress",
  });
  assert.throws(
    () => validateCompose(extraPort),
    /exactly the three audited loopback TCP ports/,
  );

  const directAppPort = structuredClone(model);
  directAppPort.services.api.ports = [
    {
      target: 3302,
      published: "3302",
      host_ip: "127.0.0.1",
      protocol: "tcp",
      mode: "ingress",
    },
  ];
  assert.throws(
    () => validateCompose(directAppPort),
    /only gateway may publish loopback ports/,
  );

  const sharedNetwork = structuredClone(model);
  sharedNetwork.networks.e2e.external = true;
  assert.throws(() => validateCompose(sharedNetwork), /non-external/);

  const extraNetwork = structuredClone(model);
  extraNetwork.services.api.networks.shared = null;
  extraNetwork.networks.shared = {
    name: "shared",
    driver: "bridge",
    external: true,
  };
  assert.throws(() => validateCompose(extraNetwork), /attach only/);

  const appOnEdge = structuredClone(model);
  appOnEdge.services.web.networks.edge = null;
  assert.throws(
    () => validateCompose(appOnEdge),
    /attach only to the isolated e2e bridge/,
  );

  const gatewayWithoutEdge = structuredClone(model);
  delete gatewayWithoutEdge.services.gateway.networks.edge;
  assert.throws(
    () => validateCompose(gatewayWithoutEdge),
    /gateway must attach only/,
  );

  const earlyGateway = structuredClone(model);
  earlyGateway.services.gateway.depends_on.web.condition = "service_started";
  assert.throws(
    () => validateCompose(earlyGateway),
    /wait for the exact healthy web dependency/,
  );

  const attachableEdge = structuredClone(model);
  attachableEdge.networks.edge.attachable = true;
  assert.throws(
    () => validateCompose(attachableEdge),
    /non-attachable project-scoped bridge/,
  );

  const internalEdge = structuredClone(model);
  internalEdge.networks.edge.internal = true;
  assert.throws(
    () => validateCompose(internalEdge),
    /non-attachable project-scoped bridge/,
  );

  const edgeDriverOption = structuredClone(model);
  edgeDriverOption.networks.edge.driver_opts = {
    "com.docker.network.bridge.name": "shared0",
  };
  assert.throws(
    () => validateCompose(edgeDriverOption),
    /unexpected or missing field/,
  );

  const privileged = structuredClone(model);
  privileged.services.web.privileged = true;
  assert.throws(
    () => validateCompose(privileged),
    /privileged or host-coupled/,
  );

  for (const [label, mutate] of [
    [
      "additional build context",
      (candidate) => {
        candidate.services.api.build.additional_contexts = { private: ROOT };
      },
    ],
    [
      "build secret",
      (candidate) => {
        candidate.services.api.build.secrets = { source: ".env" };
      },
    ],
    [
      "inline Dockerfile",
      (candidate) => {
        candidate.services.api.build.dockerfile_inline = "FROM scratch";
      },
    ],
    [
      "host build network",
      (candidate) => {
        candidate.services.api.build.network = "host";
      },
    ],
    [
      "build entitlement",
      (candidate) => {
        candidate.services.api.build.entitlements = ["network.host"];
      },
    ],
    [
      "build args",
      (candidate) => {
        candidate.services.api.build.args = { PRIVATE_VALUE: "ambient" };
      },
    ],
    [
      "build SSH forwarding",
      (candidate) => {
        candidate.services.api.build.ssh = ["default"];
      },
    ],
    [
      "build cache source",
      (candidate) => {
        candidate.services.api.build.cache_from = ["type=local,src=."];
      },
    ],
    [
      "build cache destination",
      (candidate) => {
        candidate.services.api.build.cache_to = ["type=local,dest=."];
      },
    ],
    [
      "extra image tag",
      (candidate) => {
        candidate.services.api.build.tags = ["shared:latest"];
      },
    ],
  ]) {
    const candidate = structuredClone(model);
    mutate(candidate);
    assert.throws(
      () => validateCompose(candidate),
      /build only from the sanitized repository context/,
      label,
    );
  }

  const escapedDockerfile = structuredClone(model);
  escapedDockerfile.services.api.build.dockerfile = "../Dockerfile";
  assert.throws(
    () => validateCompose(escapedDockerfile),
    /build only from the sanitized repository context/,
  );

  for (const [label, mutate, pattern] of [
    [
      "object-shaped service secret",
      (candidate) => {
        candidate.services.api.secrets = { private: {} };
      },
      /configs or secrets/,
    ],
    [
      "object-shaped service config",
      (candidate) => {
        candidate.services.api.configs = { private: {} };
      },
      /configs or secrets/,
    ],
    [
      "volumes_from",
      (candidate) => {
        candidate.services.api.volumes_from = ["private"];
      },
      /host-coupled/,
    ],
    [
      "external_links",
      (candidate) => {
        candidate.services.api.external_links = ["private:db"];
      },
      /host-coupled/,
    ],
    [
      "extra_hosts",
      (candidate) => {
        candidate.services.api.extra_hosts = { host: "host-gateway" };
      },
      /host-coupled/,
    ],
    [
      "pull policy",
      (candidate) => {
        candidate.services.api.pull_policy = "always";
      },
      /host-coupled/,
    ],
    [
      "extra security opt",
      (candidate) => {
        candidate.services.api.security_opt.push("seccomp=unconfined");
      },
      /locked-down non-root/,
    ],
    [
      "top-level secret",
      (candidate) => {
        candidate.secrets = { private: { file: ".env" } };
      },
      /top-level configs or secrets/,
    ],
    [
      "top-level config",
      (candidate) => {
        candidate.configs = { private: { file: "private" } };
      },
      /top-level configs or secrets/,
    ],
    [
      "service env_file",
      (candidate) => {
        candidate.services.api.env_file = [".env.private"];
      },
      /unexpected or missing field/,
    ],
    [
      "service DNS",
      (candidate) => {
        candidate.services.api.dns = ["8.8.8.8"];
      },
      /unexpected or missing field/,
    ],
    [
      "service links",
      (candidate) => {
        candidate.services.api.links = ["personal-db"];
      },
      /unexpected or missing field/,
    ],
    [
      "service runtime",
      (candidate) => {
        candidate.services.api.runtime = "runc";
      },
      /unexpected or missing field/,
    ],
    [
      "external logging",
      (candidate) => {
        candidate.services.api.logging = { driver: "syslog" };
      },
      /unexpected or missing field/,
    ],
  ]) {
    const candidate = structuredClone(model);
    mutate(candidate);
    assert.throws(() => validateCompose(candidate), pattern, label);
  }

  const extraEnvironment = structuredClone(model);
  extraEnvironment.services.api.environment.ATTACKER_VALUE =
    "loaded from a host env_file";
  assert.throws(
    () => validateCompose(extraEnvironment),
    /only the runner-owned environment contract/,
  );

  const replacedSecret = structuredClone(model);
  replacedSecret.services.db.environment.POSTGRES_PASSWORD =
    "ambient-host-secret";
  assert.throws(
    () => validateCompose(replacedSecret),
    /environment does not match the runner-owned contract/,
  );

  for (const hostileDsn of [
    model.services.api.environment.DATABASE_URL.replace(
      "@db:5432",
      "@host.docker.internal:5434",
    ),
    model.services.api.environment.DATABASE_URL.replace(
      "@db:5432",
      "@127.0.0.1:5434",
    ),
    model.services.api.environment.DATABASE_URL.replace(
      FIXED_IDENTITY.runnerPassword,
      "wrong-runner-password",
    ),
    model.services.api.environment.DATABASE_URL.replace(
      "charitypilot_e2e_runner:",
      "charitypilot:",
    ),
    `${model.services.api.environment.DATABASE_URL}&target_session_attrs=read-write`,
    model.services.api.environment.DATABASE_URL.replace(
      "charitypilot_e2e_disposable",
      "charitypilot",
    ),
    model.services.api.environment.DATABASE_URL.replace(
      "schema=public",
      "schema=private",
    ),
    model.services.api.environment.DATABASE_URL.replace(
      "application_name=charitypilot-api-e2e",
      "application_name=personal-app",
    ),
  ]) {
    const candidate = structuredClone(model);
    candidate.services.api.environment.DATABASE_URL = hostileDsn;
    assert.throws(
      () => validateCompose(candidate),
      /environment does not match the runner-owned contract/,
    );
  }

  const mismatchedInstance = structuredClone(model);
  mismatchedInstance.services.api.environment.E2E_DATABASE_INSTANCE_ID =
    "d91175fe-d317-4633-aeaa-f0045019067c";
  assert.throws(
    () => validateCompose(mismatchedInstance),
    /environment does not match the runner-owned contract/,
  );

  const mismatchedDatabaseInstance = structuredClone(model);
  mismatchedDatabaseInstance.services.db.environment.E2E_DATABASE_INSTANCE_ID =
    "d91175fe-d317-4633-aeaa-f0045019067c";
  assert.throws(
    () => validateCompose(mismatchedDatabaseInstance),
    /environment does not match the runner-owned contract/,
  );

  for (const [name, value] of [
    ["NODE_ENV", "development"],
    ["NEXT_PUBLIC_API_URL", "http://localhost:3002"],
    ["NEXT_PUBLIC_CHARITYPILOT_E2E_MODE", "local-disposable-lookalike"],
    ["CHARITYPILOT_INTERNAL_API_URL", "http://localhost:3002"],
  ]) {
    const candidate = structuredClone(model);
    candidate.services.web.environment[name] = value;
    assert.throws(
      () => validateCompose(candidate),
      /environment does not match the runner-owned contract/,
      `web ${name}`,
    );
  }

  const udpGateway = structuredClone(model);
  udpGateway.services.gateway.ports.find(
    (port) => port.target === 3302,
  ).protocol = "udp";
  assert.throws(
    () => validateCompose(udpGateway),
    /exact audited TCP routes on 127\.0\.0\.1/,
  );

  const changedCommand = structuredClone(model);
  changedCommand.services.api.command[2] = "node attacker-script.js";
  assert.throws(
    () => validateCompose(changedCommand),
    /audited isolated startup command/,
  );

  const changedEntrypoint = structuredClone(model);
  changedEntrypoint.services.api.entrypoint = [
    "/bin/sh",
    "-lc",
    "node attacker-script.js",
  ];
  assert.throws(
    () => validateCompose(changedEntrypoint),
    /audited isolated startup command/,
  );

  const changedGatewayEntrypoint = structuredClone(model);
  changedGatewayEntrypoint.services.gateway.entrypoint = ["sh", "-lc"];
  assert.throws(
    () => validateCompose(changedGatewayEntrypoint),
    /audited isolated startup command/,
  );

  const changedWebCommand = structuredClone(model);
  changedWebCommand.services.web.command = ["sh", "-lc", "next dev"];
  assert.throws(
    () => validateCompose(changedWebCommand),
    /audited isolated startup command/,
  );

  const privilegedGateway = structuredClone(model);
  privilegedGateway.services.gateway.cap_drop = [];
  assert.throws(
    () => validateCompose(privilegedGateway),
    /locked-down non-root app user/,
  );

  for (const [label, mutate, pattern] of [
    [
      "missing API alias",
      (candidate) => {
        delete candidate.services.api.networks.e2e.aliases;
      },
      /unexpected or missing field/,
    ],
    [
      "replaced API alias",
      (candidate) => {
        candidate.services.api.networks.e2e.aliases = ["personal-db"];
      },
      /exact reserved isolated e2e network alias/,
    ],
    [
      "shared API alias",
      (candidate) => {
        candidate.services.api.networks.e2e.aliases = [
          "db.charitypilot-e2e.invalid",
        ];
      },
      /exact reserved isolated e2e network alias/,
    ],
    [
      "extra API alias",
      (candidate) => {
        candidate.services.api.networks.e2e.aliases.push("api");
      },
      /exact reserved isolated e2e network alias/,
    ],
    [
      "replaced DB alias",
      (candidate) => {
        candidate.services.db.networks.e2e.aliases = [
          "api.charitypilot-e2e.invalid",
        ];
      },
      /exact reserved isolated e2e network alias/,
    ],
    [
      "replaced web alias",
      (candidate) => {
        candidate.services.web.networks.e2e.aliases = [
          "api.charitypilot-e2e.invalid",
        ];
      },
      /exact reserved isolated e2e network alias/,
    ],
  ]) {
    const candidate = structuredClone(model);
    mutate(candidate);
    assert.throws(() => validateCompose(candidate), pattern, label);
  }

  const gatewayAlias = structuredClone(model);
  gatewayAlias.services.gateway.networks.edge = { aliases: ["public-gateway"] };
  assert.throws(
    () => validateCompose(gatewayAlias),
    /gateway must attach only/,
  );

  const gatewayInternalAlias = structuredClone(model);
  gatewayInternalAlias.services.gateway.networks.e2e = {
    aliases: ["gateway.charitypilot-e2e.invalid"],
  };
  assert.throws(
    () => validateCompose(gatewayInternalAlias),
    /gateway must attach only/,
  );

  const gatewayEnvironment = structuredClone(model);
  gatewayEnvironment.services.gateway.environment = {
    SECRET: "must-not-enter-gateway",
  };
  assert.throws(
    () => validateCompose(gatewayEnvironment),
    /must not receive any runtime environment value|unexpected or missing field/,
  );

  const webBuildRace = structuredClone(model);
  webBuildRace.services.web.build = {
    context: FIXED_IDENTITY.buildContextPath,
    dockerfile: "e2e/docker/Dockerfile",
    target: "app",
  };
  assert.throws(
    () => validateCompose(webBuildRace),
    /must reuse the exact prebuilt runner app image/,
  );
});

test("loopback port check refuses an occupied port without stopping its owner", async () => {
  const owner = createServer();
  await new Promise((resolvePromise) =>
    owner.listen(0, "127.0.0.1", resolvePromise),
  );
  const address = owner.address();
  assert.equal(typeof address, "object");

  await assert.rejects(
    assertLoopbackPortsAvailable([{ name: "test", port: address.port }]),
    /is unavailable; the isolated E2E runner will not reuse or stop the process that owns it/,
  );
  assert.equal(owner.listening, true);
  await new Promise((resolvePromise) => owner.close(resolvePromise));
});

test("Docker endpoint preflight accepts only local sockets and rejects ambient context/TLS overrides", async () => {
  assert.equal(
    validateLocalDockerEndpoint("unix:///var/run/docker.sock"),
    "unix:///var/run/docker.sock",
  );
  assert.equal(
    validateLocalDockerEndpoint("npipe:////./pipe/docker_engine"),
    "npipe:////./pipe/docker_engine",
  );
  for (const endpoint of [
    "tcp://127.0.0.1:2375",
    "https://docker.example.test",
    "ssh://builder@example.test",
    "unix://remote.example.test/var/run/docker.sock",
    "unix:///tmp/../remote.sock",
    "",
  ]) {
    assert.throws(
      () => validateLocalDockerEndpoint(endpoint),
      /local unix socket|missing or malformed|malformed/,
    );
  }
  assert.throws(
    () => assertNoDockerEndpointOverrides({ DOCKER_CONTEXT: "remote-builder" }),
    /refuses Docker endpoint\/context\/TLS overrides/,
  );
  assert.throws(
    () => assertNoDockerEndpointOverrides({ DOCKER_TLS_VERIFY: "1" }),
    /refuses Docker endpoint\/context\/TLS overrides/,
  );
  for (const [name, value] of [
    ["BUILDX_BUILDER", "remote-builder"],
    ["BUILDKIT_HOST", "tcp://builder.example.test:1234"],
    ["BUILDX_CONFIG", "/tmp/attacker-buildx"],
    ["COMPOSE_BAKE", "true"],
  ]) {
    assert.throws(
      () => assertNoDockerEndpointOverrides({ [name]: value }),
      /refuses Docker endpoint\/context\/TLS overrides/,
      name,
    );
  }

  const commands = [];
  const endpoint = await verifyLocalDockerContext(async (command, args) => {
    commands.push([command, ...args]);
    return { code: 0, stdout: '"unix:///var/run/docker.sock"\n', stderr: "" };
  }, {});
  assert.equal(endpoint, "unix:///var/run/docker.sock");
  assert.deepEqual(commands[0], [
    "docker",
    "context",
    "inspect",
    "--format",
    "{{json .Endpoints.docker.Host}}",
  ]);

  const builderCommands = [];
  assert.equal(
    await verifyIntegratedLocalBuilder(
      async (command, args) => {
        builderCommands.push([command, ...args]);
        return {
          code: 0,
          stdout: "Name: default\nDriver: docker\n",
          stderr: "",
        };
      },
      {},
      endpoint,
    ),
    "docker",
  );
  assert.deepEqual(builderCommands[0], [
    "docker",
    "--host",
    endpoint,
    "buildx",
    "inspect",
    "default",
  ]);
  await assert.rejects(
    verifyIntegratedLocalBuilder(
      async () => ({
        code: 0,
        stdout: "Name: default\nDriver: docker-container\n",
        stderr: "",
      }),
      {},
      endpoint,
    ),
    /local integrated docker driver/,
  );
});

test("runtime inspect collectors use the pinned daemon and reject malformed evidence before reset", async () => {
  const imageCommands = [];
  await assert.rejects(
    captureBuiltImageAttestation(
      async (command, args, options) => {
        imageCommands.push({ command, args, options });
        return { code: 0, stdout: "not-json", stderr: "" };
      },
      "unix:///var/run/docker.sock",
      FIXED_IDENTITY,
      {},
    ),
    /image inspect did not return valid JSON/,
  );
  assert.deepEqual(imageCommands[0].args, [
    "--host",
    "unix:///var/run/docker.sock",
    "image",
    "inspect",
    FIXED_IDENTITY.appImage,
    FIXED_IDENTITY.databaseImage,
    FIXED_IDENTITY.gatewayImage,
  ]);
  assert.equal(imageCommands[0].options.capture, true);
  assert.equal(imageCommands[0].options.timeoutMs, 60_000);

  const containerCommands = [];
  await assert.rejects(
    captureRunningContainerAttestation(
      async (command, args, options) => {
        containerCommands.push({ command, args, options });
        return { code: 0, stdout: "attacker-controlled-id\n", stderr: "" };
      },
      "unix:///var/run/docker.sock",
      FIXED_IDENTITY,
      {},
      { synthetic: "built" },
    ),
    /exactly four runner-owned service containers/,
  );
  assert.equal(containerCommands.length, 1);
  assert.deepEqual(containerCommands[0].args, [
    "--host",
    "unix:///var/run/docker.sock",
    "container",
    "ls",
    "--all",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${FIXED_IDENTITY.projectName}`,
  ]);
  assert.equal(containerCommands[0].options.capture, true);
  assert.equal(containerCommands[0].options.timeoutMs, 60_000);
});

test("standalone Compose source cannot read secondary host files before model validation", () => {
  assert.doesNotThrow(() =>
    assertStandaloneComposeSource("services:\n  api:\n    image: safe\n"),
  );
  for (const directive of [
    "include: private.compose.yml",
    "    env_file: .env.private",
    "    extends: private.compose.yml",
    "    label_file: private.labels",
    '"include": private.compose.yml',
    "    'env_file': .env.private",
  ]) {
    assert.throws(
      () => assertStandaloneComposeSource(`services:\n  api:\n${directive}\n`),
      /must not load any secondary host file/,
      directive,
    );
  }
});

test("runner executes one private Compose snapshot after the mutable source is replaced", async () => {
  assert.throws(
    () =>
      composeInvocation(
        FIXED_IDENTITY.projectName,
        "compose.env",
        undefined,
        "config",
      ),
    /runner-owned Compose snapshot is required/,
  );

  const scratch = await mkdtemp(join(tmpdir(), "charitypilot-compose-source-"));
  const sourcePath = join(scratch, "compose.e2e.yml");
  const originalBytes = await readFile(COMPOSE_FILE);
  await writeFile(sourcePath, originalBytes);
  const commands = [];
  let sourceReadCount = 0;
  let runnerTempRoot;
  let snapshotPath;
  let builtRuntimeEvidence;
  let runningAttestationCalls = 0;

  const commandRunner = async (command, args) => {
    commands.push([command, ...args]);
    if (args.includes("config")) {
      const fileIndex = args.indexOf("--file");
      snapshotPath = args[fileIndex + 1];
      assert.equal(
        snapshotPath,
        join(runnerTempRoot, "compose.e2e.snapshot.yml"),
      );
      assert.deepEqual(await readFile(snapshotPath), originalBytes);
      if (process.platform !== "win32") {
        assert.equal((await stat(snapshotPath)).mode & 0o777, 0o600);
      }
      await writeFile(
        sourcePath,
        "services:\n  attacker:\n    image: attacker.example/changed:latest\ninclude:\n  - private.yml\n",
      );
      return { code: 0, stdout: JSON.stringify(renderedCompose()), stderr: "" };
    }
    if (args.includes("context")) {
      return { code: 0, stdout: '"unix:///var/run/docker.sock"', stderr: "" };
    }
    if (args.includes("buildx")) {
      return { code: 0, stdout: "Name: default\nDriver: docker\n", stderr: "" };
    }
    if (command === "docker") return { code: 0, stdout: "", stderr: "" };
    throw new Error(
      "synthetic Playwright failure after Compose source replacement",
    );
  };

  try {
    await assert.rejects(
      runIsolatedE2e([], {
        ...TEST_RUNTIME_ATTESTATION_STUBS,
        captureBuiltImageAttestation: async () => {
          assert.ok(
            commands.some(
              (entry) => entry.includes("compose") && entry.includes("build"),
            ),
          );
          assert.equal(
            commands.some(
              (entry) => entry.includes("compose") && entry.includes("up"),
            ),
            false,
          );
          builtRuntimeEvidence = { synthetic: "immutable-image-ids" };
          return builtRuntimeEvidence;
        },
        captureRunningContainerAttestation: async (
          _runCommand,
          _endpoint,
          _identity,
          _env,
          built,
        ) => {
          assert.equal(built, builtRuntimeEvidence);
          assert.ok(
            commands.some(
              (entry) => entry.includes("compose") && entry.includes("up"),
            ),
          );
          assert.equal(
            commands.some((entry) => entry[0] !== "docker"),
            false,
          );
          runningAttestationCalls += 1;
          return { synthetic: "running-containers" };
        },
        env: {},
        identity: FIXED_IDENTITY,
        composeSourcePath: sourcePath,
        composeSourceReader: async (path) => {
          sourceReadCount += 1;
          return readFile(path);
        },
        buildContextCreator: async () => {},
        onTempRoot: (value) => {
          runnerTempRoot = value;
        },
        portChecker: async () => {},
        runCommand: commandRunner,
        waitOptions: {
          fetchFn: async () => new Response("", { status: 200 }),
        },
      }),
      /synthetic Playwright failure after Compose source replacement/,
    );

    assert.equal(sourceReadCount, 1);
    assert.equal(runningAttestationCalls, 1);
    const composeCommands = commands.filter(
      (entry) => entry[0] === "docker" && entry.includes("compose"),
    );
    for (const operation of ["config", "build", "up", "logs", "down"]) {
      assert.ok(
        composeCommands.some((entry) => entry.includes(operation)),
        `${operation} must use Compose`,
      );
    }
    for (const command of composeCommands) {
      assert.equal(command[command.indexOf("--file") + 1], snapshotPath);
      assert.equal(command[command.indexOf("--project-directory") + 1], ROOT);
      assert.equal(command.includes(sourcePath), false);
      assert.equal(command.includes(COMPOSE_FILE), false);
    }
    assert.equal(existsSync(runnerTempRoot), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
    if (runnerTempRoot)
      await rm(runnerTempRoot, { recursive: true, force: true });
  }
});

test("Compose snapshot write failure removes all runner-owned temporary state before Docker", async () => {
  const identity = createLocalRunIdentity();
  const commands = [];
  let runnerTempRoot;
  let buildContextCalls = 0;

  await assert.rejects(
    runIsolatedE2e(["--validate-only"], {
      env: {},
      identity,
      composeSnapshotWriter: async () => {
        throw new Error("synthetic Compose snapshot write failure");
      },
      buildContextCreator: async () => {
        buildContextCalls += 1;
      },
      onTempRoot: (value) => {
        runnerTempRoot = value;
      },
      portChecker: async () => {},
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
    /synthetic Compose snapshot write failure/,
  );

  assert.equal(buildContextCalls, 0);
  assert.deepEqual(commands, []);
  assert.equal(existsSync(runnerTempRoot), false);
  assert.equal(existsSync(identity.buildContextPath), false);
});

test("malformed UTF-8 Compose bytes are rejected before snapshot, build context, or Docker", async () => {
  const scratch = await mkdtemp(
    join(tmpdir(), "charitypilot-compose-invalid-utf8-"),
  );
  const sourcePath = join(scratch, "compose.e2e.yml");
  const sourceBytes = await readFile(COMPOSE_FILE);
  await writeFile(
    sourcePath,
    Buffer.concat([sourceBytes, Buffer.from([0xff])]),
  );
  const commands = [];
  let runnerTempRoot;
  let buildContextCalls = 0;

  try {
    await assert.rejects(
      runIsolatedE2e(["--validate-only"], {
        env: {},
        identity: FIXED_IDENTITY,
        composeSourcePath: sourcePath,
        buildContextCreator: async () => {
          buildContextCalls += 1;
        },
        onTempRoot: (value) => {
          runnerTempRoot = value;
        },
        portChecker: async () => {},
        runCommand: async (command, args) => {
          commands.push([command, ...args]);
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
      /Compose source must be valid UTF-8/,
    );
    assert.equal(buildContextCalls, 0);
    assert.deepEqual(commands, []);
    assert.equal(existsSync(runnerTempRoot), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
    if (runnerTempRoot)
      await rm(runnerTempRoot, { recursive: true, force: true });
  }
});

test("endpoint polling aborts promptly on runner shutdown instead of waiting for its poll budget", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const waiting = waitForEndpoint("http://127.0.0.1:3302/", "test endpoint", {
    timeoutMs: 60_000,
    pollMs: 60_000,
    signal: controller.signal,
    fetchFn: async () => new Response("", { status: 503 }),
  });
  setTimeout(() => controller.abort(new Error("synthetic SIGTERM")), 10);

  await assert.rejects(waiting, /synthetic SIGTERM/);
  assert.ok(
    Date.now() - started < 1_000,
    "abort should interrupt the long poll immediately",
  );
});

test("runner keeps signal handling active through exact-project cleanup without killing cleanup children", () => {
  const source = readFileSync(
    join(ROOT, "scripts", "run-isolated-e2e.mjs"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const shutdownBody = source.slice(
    source.indexOf("const requestShutdown ="),
    source.indexOf("const onSigint ="),
  );
  assert.match(shutdownBody, /receivedSignal \?\?= reason/);
  assert.match(
    shutdownBody,
    /if \(!cleanupStarted && activeChild\) \{\s*void beginExactTreeShutdown\(activeChild\)/,
  );
  assert.match(source, /process\.on\(["']SIGINT["'], onSigint\)/);
  assert.match(source, /process\.on\(["']SIGTERM["'], onSigterm\)/);
  assert.doesNotMatch(source, /process\.once\(["']SIG(?:INT|TERM)["']/);

  assert.match(source, /timeout: timeoutMs/);
  assert.match(source, /result\?\.status !== 0/);
  assert.match(source, /processKillFn\(-child\.pid, 0\)/);
  assert.match(source, /error\?\.code === ["']ESRCH["']/);

  const deployedBranchStart = source.indexOf(
    'if (env.E2E_DEPLOYED_QA === "true")',
  );
  assert.ok(
    source.indexOf('process.on("SIGINT", onSigint)') < deployedBranchStart,
  );
  assert.ok(
    source.indexOf('process.on("SIGTERM", onSigterm)') < deployedBranchStart,
  );
  assert.ok(
    source.indexOf("setTimeout(() => requestShutdown") < deployedBranchStart,
  );

  const nonLocalFinalizerStart = source.indexOf("const finalizeNonLocalRun =");
  const nonLocalFinalizer = source.slice(
    nonLocalFinalizerStart,
    source.indexOf(
      'if (env.E2E_DEPLOYED_QA === "true")',
      nonLocalFinalizerStart,
    ),
  );
  assert.ok(
    nonLocalFinalizer.indexOf("awaitExactTreeShutdownProof") <
      nonLocalFinalizer.indexOf("cleanupStarted = true") &&
      nonLocalFinalizer.indexOf("cleanupStarted = true") <
        nonLocalFinalizer.indexOf("remoteDatabaseJanitor") &&
      nonLocalFinalizer.indexOf("remoteDatabaseJanitor") <
        nonLocalFinalizer.indexOf("removeLifecycleHandlers()"),
    "non-local signal handlers must remain active through exact-child shutdown and remote cleanup",
  );
  assert.match(
    nonLocalFinalizer,
    /if \(remoteAuthorized && exactTreeAbsenceProven\)/,
  );

  const localCleanupFinallyStart = source.indexOf(
    "  } finally {\n    let treeProofError;",
  );
  const localCleanupFinally = source.slice(
    localCleanupFinallyStart,
    source.indexOf("    if (receivedSignal)", localCleanupFinallyStart),
  );
  assert.ok(
    localCleanupFinally.indexOf("awaitExactTreeShutdownProof") <
      localCleanupFinally.indexOf("await cleanup()") &&
      localCleanupFinally.indexOf("await cleanup()") <
        localCleanupFinally.lastIndexOf("removeLifecycleHandlers()"),
    "local signal handlers and the overall timeout must remain active until bounded cleanup completes",
  );
});

test("checked Windows taskkill is bounded and accepts only positive exit evidence", () => {
  const child = new EventEmitter();
  child.pid = 42;
  const calls = [];
  checkedWindowsTaskkill(child, {
    timeoutMs: 321,
    spawnSyncFn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, signal: null };
    },
  });
  assert.equal(calls[0].command, "taskkill");
  assert.deepEqual(calls[0].args, ["/PID", "42", "/T", "/F"]);
  assert.equal(calls[0].options.timeout, 321);

  for (const result of [
    { status: 1, signal: null },
    { status: null, signal: "SIGTERM" },
    { status: null, signal: null, error: new Error("timeout") },
  ]) {
    assert.throws(
      () =>
        checkedWindowsTaskkill(Object.assign(new EventEmitter(), { pid: 43 }), {
          spawnSyncFn: () => result,
        }),
      /did not positively terminate/,
    );
  }
});

test("POSIX group probe accepts only ESRCH as exact absence evidence", () => {
  const child = { pid: 44 };
  assert.equal(
    isExactPosixChildGroupAbsent(child, { processKillFn: () => undefined }),
    false,
  );
  assert.equal(
    isExactPosixChildGroupAbsent(child, {
      processKillFn: () => {
        const error = new Error("absent");
        error.code = "ESRCH";
        throw error;
      },
    }),
    true,
  );
  assert.throws(
    () =>
      isExactPosixChildGroupAbsent(child, {
        processKillFn: () => {
          const error = new Error("denied");
          error.code = "EPERM";
          throw error;
        },
      }),
    /could not be probed safely/,
  );
});

test("exact POSIX shutdown requires both group absence and observed leader close", async () => {
  const closingChild = new EventEmitter();
  closingChild.pid = 42;
  closingChild.exitCode = null;
  closingChild.signalCode = null;
  const signals = [];
  let groupPresent = true;
  await stopAndWaitForExactChildTree(closingChild, {
    platform: "linux",
    termGraceMs: 1,
    killGraceMs: 20,
    probeFn: async () => !groupPresent,
    terminateFn: (_child, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") {
        groupPresent = false;
        closingChild.signalCode = "SIGTERM";
        queueMicrotask(() => closingChild.emit("close"));
      }
    },
  });
  assert.deepEqual(signals, ["SIGTERM"]);

  const survivingChild = new EventEmitter();
  survivingChild.pid = 43;
  survivingChild.exitCode = null;
  survivingChild.signalCode = null;
  await assert.rejects(
    stopAndWaitForExactChildTree(survivingChild, {
      platform: "linux",
      termGraceMs: 5,
      killGraceMs: 5,
      probeFn: async () => false,
      terminateFn: () => {},
    }),
    /survived bounded SIGTERM\/SIGKILL shutdown/,
  );
});

test("ordinary POSIX leader close cannot settle before descendant absence proof", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 45,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  let releaseProof;
  const proof = new Promise((resolvePromise) => {
    releaseProof = resolvePromise;
  });
  const tracking = [];
  const runner = createCommandRunner({
    spawnFn: () => child,
    onChild: (value) => tracking.push(value),
    shutdownChild: async () => proof,
  });
  let settled = false;
  const command = runner("synthetic", [], {
    requireExactTreeAbsenceOnClose: true,
  }).finally(() => {
    settled = true;
  });
  child.exitCode = 1;
  child.emit("close", 1, null);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(settled, false);
  assert.equal(tracking.at(-1), child);
  releaseProof();
  await assert.rejects(command, /synthetic exited 1/);
  assert.equal(tracking.at(-1), null);
});

test("command runner prevents an already-aborted spawn and awaits active-child proof", async () => {
  const preAborted = new AbortController();
  preAborted.abort(new Error("synthetic pre-spawn deadline"));
  let spawnCalls = 0;
  const preAbortedRunner = createCommandRunner({
    spawnFn: () => {
      spawnCalls += 1;
      assert.fail("an already-aborted command must not spawn");
    },
  });
  await assert.rejects(
    async () =>
      preAbortedRunner("synthetic", [], { signal: preAborted.signal }),
    /synthetic pre-spawn deadline/,
  );
  assert.equal(spawnCalls, 0);

  const controller = new AbortController();
  const child = Object.assign(new EventEmitter(), {
    pid: 46,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  let shutdownCalls = 0;
  let releaseProof;
  const proof = new Promise((resolvePromise) => {
    releaseProof = resolvePromise;
  });
  const tracking = [];
  const activeRunner = createCommandRunner({
    spawnFn: () => child,
    onChild: (value) => tracking.push(value),
    shutdownChild: async () => {
      shutdownCalls += 1;
      await proof;
    },
  });
  let settled = false;
  const activeCommand = activeRunner("synthetic", [], {
    signal: controller.signal,
    requireExactTreeAbsenceOnClose: false,
  }).finally(() => {
    settled = true;
  });
  controller.abort(new Error("synthetic active deadline"));
  child.signalCode = "SIGTERM";
  child.emit("close", null, "SIGTERM");
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(shutdownCalls, 1);
  assert.equal(settled, false);
  assert.equal(tracking.at(-1), child);
  releaseProof();
  await assert.rejects(activeCommand, /synthetic active deadline/);
  assert.equal(tracking.at(-1), null);
});

test("runner-owned deadline cleans only its exact project and verifies zero Docker residue", async () => {
  const commands = [];
  const commandTimeouts = [];
  let projectName;
  const commandRunner = async (command, args, options = {}) => {
    commands.push([command, ...args]);
    commandTimeouts.push({ args, timeoutMs: options.timeoutMs });
    if (args.includes("config"))
      return { code: 0, stdout: JSON.stringify(renderedCompose()), stderr: "" };
    if (args.includes("context"))
      return { code: 0, stdout: '"unix:///var/run/docker.sock"', stderr: "" };
    if (args.includes("buildx"))
      return { code: 0, stdout: "Name: default\nDriver: docker\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  await assert.rejects(
    runIsolatedE2e([], {
      ...TEST_RUNTIME_ATTESTATION_STUBS,
      env: {},
      identity: FIXED_IDENTITY,
      buildContextCreator: async () => {},
      // The common deadline now includes every preflight and build step. Leave
      // enough setup budget for a loaded Windows host; the endpoint poll below
      // is held for 60 seconds, so this still fires only after the stack is addressed.
      overallTimeoutMs: 5_000,
      onProject: (value) => {
        projectName = value;
      },
      portChecker: async () => {},
      runCommand: commandRunner,
      waitOptions: {
        pollMs: 60_000,
        fetchFn: async () => new Response("", { status: 503 }),
      },
    }),
    (error) => {
      assert.equal(error.exitCode, 124);
      assert.match(error.message, /TIMEOUT; stack cleanup completed/);
      return true;
    },
  );

  assert.equal(projectName, FIXED_IDENTITY.projectName);
  const down = commands.find((command) => command.includes("down"));
  assert.ok(down?.includes(FIXED_IDENTITY.projectName));
  assert.equal(
    commandTimeouts.find((entry) => entry.args.includes("down"))?.timeoutMs,
    600_000,
  );
  const resourceChecks = commands.filter((command) =>
    command.includes(
      "label=com.docker.compose.project=charitypilot-e2e-9d9899dc9bea45caa916",
    ),
  );
  assert.equal(resourceChecks.length, 3);
  assert.equal(
    commands.some((command) =>
      command.join(" ").includes("charitypilot-e2e-concurrent"),
    ),
    false,
  );
  assert.ok(
    commands.some((command) => command.includes(FIXED_IDENTITY.gatewayImage)),
  );
  const builder = commands.find((command) => command.includes("buildx"));
  const build = commands.find((command) => command.includes("build"));
  const up = commands.find((command) => command.includes("up"));
  assert.deepEqual(builder?.slice(0, 3), [
    "docker",
    "--host",
    "unix:///var/run/docker.sock",
  ]);
  assert.ok(build?.includes("--builder") && build.includes("default"));
  assert.equal(
    commandTimeouts.find(
      (entry) => entry.args.includes("build") && !entry.args.includes("buildx"),
    )?.timeoutMs,
    1_500_000,
  );
  assert.ok(up?.includes("--no-build"));
  assert.ok(up?.includes("--pull") && up.includes("never"));
  const residueTimeouts = commandTimeouts.filter(
    (entry) =>
      entry.args.includes("--filter") ||
      (entry.args.includes("image") && entry.args.includes("ls")),
  );
  assert.equal(residueTimeouts.length, 6);
  assert.equal(
    residueTimeouts.every((entry) => entry.timeoutMs === 120_000),
    true,
  );
  for (const command of commands.filter(
    (entry) =>
      entry.includes("buildx") ||
      entry.includes("build") ||
      entry.includes("up") ||
      entry.includes("down") ||
      entry.includes("logs") ||
      entry.includes("ps") ||
      entry.includes("volume") ||
      entry.includes("network") ||
      entry.includes("image"),
  )) {
    assert.deepEqual(command.slice(0, 3), [
      "docker",
      "--host",
      "unix:///var/run/docker.sock",
    ]);
  }
});

test("validate-only renders and validates compose without booting a container", async () => {
  const commands = [];
  const commandRunner = async (command, args) => {
    commands.push([command, ...args]);
    return { code: 0, stdout: JSON.stringify(renderedCompose()), stderr: "" };
  };

  const result = await runIsolatedE2e(["--validate-only"], {
    env: {},
    identity: FIXED_IDENTITY,
    buildContextCreator: async () => {},
    portChecker: async () => {},
    runCommand: commandRunner,
  });

  assert.equal(result, 0);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].slice(-4), [
    "config",
    "--no-env-resolution",
    "--format",
    "json",
  ]);
  assert.equal(
    commands.some((command) => command.includes("up")),
    false,
  );
  assert.equal(
    commands.some((command) => command.includes("down")),
    false,
  );
});

test("a failed stack boot still tears down the generated project with volumes and orphans", async () => {
  const commands = [];
  const commandRunner = async (command, args, options = {}) => {
    commands.push([command, ...args]);
    if (args.includes("config"))
      return { code: 0, stdout: JSON.stringify(renderedCompose()), stderr: "" };
    if (args.includes("context"))
      return { code: 0, stdout: '"unix:///var/run/docker.sock"', stderr: "" };
    if (args.includes("buildx"))
      return { code: 0, stdout: "Name: default\nDriver: docker\n", stderr: "" };
    if (args.includes("up")) throw new Error("synthetic boot failure");
    if (args.includes("logs"))
      throw new Error("synthetic log collection failure");
    return { code: options.allowFailure ? 0 : 0, stdout: "", stderr: "" };
  };

  await assert.rejects(
    runIsolatedE2e([], {
      ...TEST_RUNTIME_ATTESTATION_STUBS,
      env: {},
      identity: FIXED_IDENTITY,
      buildContextCreator: async () => {},
      portChecker: async () => {},
      runCommand: commandRunner,
    }),
    /synthetic boot failure/,
  );

  const down = commands.find((command) => command.includes("down"));
  assert.ok(down, "cleanup must invoke docker compose down");
  assert.ok(down.includes("--volumes"));
  assert.ok(down.includes("--remove-orphans"));
  assert.ok(down.includes("--rmi"));
  assert.ok(down.includes("all"));
  assert.ok(down.includes(FIXED_IDENTITY.projectName));
});

test("a failed teardown makes the run red and preserves private cleanup inputs", async () => {
  let recoveryDirectory;
  const commandRunner = async (_command, args) => {
    if (args.includes("config"))
      return { code: 0, stdout: JSON.stringify(renderedCompose()), stderr: "" };
    if (args.includes("context"))
      return { code: 0, stdout: '"unix:///var/run/docker.sock"', stderr: "" };
    if (args.includes("buildx"))
      return { code: 0, stdout: "Name: default\nDriver: docker\n", stderr: "" };
    if (args.includes("up")) throw new Error("synthetic boot failure");
    if (args.includes("down"))
      return { code: 17, stdout: "", stderr: "synthetic teardown failure" };
    return { code: 0, stdout: "", stderr: "" };
  };

  try {
    await assert.rejects(
      runIsolatedE2e([], {
        ...TEST_RUNTIME_ATTESTATION_STUBS,
        env: {},
        identity: FIXED_IDENTITY,
        buildContextCreator: async () => {},
        onTempRoot: (value) => {
          recoveryDirectory = value;
        },
        portChecker: async () => {},
        runCommand: commandRunner,
      }),
      (error) => {
        assert.equal(error.recoveryDirectory, recoveryDirectory);
        assert.match(error.message, /teardown failed; the run is not green/);
        assert.match(error.message, /charitypilot-e2e-/);
        assert.match(error.message, /synthetic teardown failure/);
        assert.match(recoveryDirectory, /charitypilot-e2e-/);
        assert.equal(
          existsSync(join(recoveryDirectory, "compose.e2e.snapshot.yml")),
          true,
        );
        assert.equal(existsSync(join(recoveryDirectory, "compose.env")), true);
        return true;
      },
    );
  } finally {
    if (recoveryDirectory)
      await rm(recoveryDirectory, { recursive: true, force: true });
  }
});

test("cleanup command throws and timeouts retain an explicit recovery directory without leaking temp fixtures", async () => {
  for (const synthetic of [
    Object.assign(new Error("synthetic cleanup command throw"), {
      exitCode: 17,
    }),
    Object.assign(new Error("docker exceeded its bounded execution time"), {
      exitCode: 124,
    }),
  ]) {
    let recoveryDirectory;
    const commandRunner = async (_command, args) => {
      if (args.includes("config"))
        return {
          code: 0,
          stdout: JSON.stringify(renderedCompose()),
          stderr: "",
        };
      if (args.includes("context"))
        return { code: 0, stdout: '"unix:///var/run/docker.sock"', stderr: "" };
      if (args.includes("buildx"))
        return {
          code: 0,
          stdout: "Name: default\nDriver: docker\n",
          stderr: "",
        };
      if (args.includes("up")) throw new Error("synthetic boot failure");
      if (args.includes("down")) throw synthetic;
      return { code: 0, stdout: "", stderr: "" };
    };

    try {
      await assert.rejects(
        runIsolatedE2e([], {
          ...TEST_RUNTIME_ATTESTATION_STUBS,
          env: {},
          identity: FIXED_IDENTITY,
          buildContextCreator: async () => {},
          onTempRoot: (value) => {
            recoveryDirectory = value;
          },
          portChecker: async () => {},
          runCommand: commandRunner,
        }),
        (error) => {
          assert.equal(error.recoveryDirectory, recoveryDirectory);
          assert.match(
            error.message,
            /teardown command failed or timed out; the run is not green/,
          );
          assert.match(
            error.message,
            new RegExp(
              synthetic.message.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            ),
          );
          assert.equal(error.exitCode, synthetic.exitCode);
          assert.match(recoveryDirectory, /charitypilot-e2e-/);
          return true;
        },
      );
    } finally {
      if (recoveryDirectory)
        await rm(recoveryDirectory, { recursive: true, force: true });
    }
  }
});

test("filesystem cleanup failures preserve private recovery inputs and identify the recovery directory", async () => {
  for (const failedTarget of ["build-context", "temp-root"]) {
    let recoveryDirectory;
    const commandRunner = async (_command, args) => {
      if (args.includes("config"))
        return {
          code: 0,
          stdout: JSON.stringify(renderedCompose()),
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    };

    try {
      await assert.rejects(
        runIsolatedE2e(["--validate-only"], {
          env: {},
          identity: FIXED_IDENTITY,
          buildContextCreator: async () => {},
          onTempRoot: (value) => {
            recoveryDirectory = value;
          },
          portChecker: async () => {},
          removePath: async (path, options) => {
            if (
              (failedTarget === "build-context" &&
                path === FIXED_IDENTITY.buildContextPath) ||
              (failedTarget === "temp-root" && path === recoveryDirectory)
            ) {
              throw new Error(`synthetic ${failedTarget} deletion failure`);
            }
            if (path === FIXED_IDENTITY.buildContextPath) return;
            await rm(path, options);
          },
          runCommand: commandRunner,
        }),
        (error) => {
          assert.equal(error.recoveryDirectory, recoveryDirectory);
          assert.match(
            error.message,
            new RegExp(`synthetic ${failedTarget} deletion failure`),
          );
          assert.match(
            error.message,
            failedTarget === "build-context"
              ? /build-context deletion failed/
              : /temporary-state deletion failed/,
          );
          assert.equal(
            existsSync(join(recoveryDirectory, "compose.e2e.snapshot.yml")),
            true,
          );
          assert.equal(
            existsSync(join(recoveryDirectory, "compose.env")),
            true,
          );
          return true;
        },
      );
    } finally {
      if (recoveryDirectory)
        await rm(recoveryDirectory, { recursive: true, force: true });
    }
  }
});

test("local runner refuses ambient reset authority", async () => {
  await assert.rejects(
    runIsolatedE2e(["--validate-only"], {
      env: { E2E_DATABASE_URL: FIXED_IDENTITY.databaseUrl },
      identity: FIXED_IDENTITY,
      portChecker: async () => {},
      runCommand: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    }),
    /does not accept ambient reset authority/,
  );

  await assert.rejects(
    runIsolatedE2e(["--validate-only"], {
      env: {
        E2E_BOOTSTRAP_PASSWORD: "ambient-secret-must-not-override-env-file",
      },
      identity: FIXED_IDENTITY,
      portChecker: async () => {},
      runCommand: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    }),
    /does not accept ambient reset authority/,
  );

  await assert.rejects(
    runIsolatedE2e(["--validate-only"], {
      env: { E2E_APP_IMAGE: "shared-or-attacker-controlled:latest" },
      identity: FIXED_IDENTITY,
      portChecker: async () => {},
      runCommand: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    }),
    /does not accept ambient reset authority/,
  );

  await assert.rejects(
    runIsolatedE2e(["--validate-only"], {
      env: { E2E_GATEWAY_IMAGE: "shared-or-attacker-controlled:latest" },
      identity: FIXED_IDENTITY,
      portChecker: async () => {},
      runCommand: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    }),
    /does not accept ambient reset authority/,
  );
});

test("remote, deployed, and local Playwright boundaries reject an abort-before-spawn race", async (t) => {
  await t.test("remote-disposable", async () => {
    const env = {
      E2E_EXECUTION_MODE: "remote-disposable",
      E2E_READINESS_API_KEY: "remote-readiness-key-with-enough-entropy",
      E2E_JWT_SECRET: "remote-jwt-secret-with-enough-entropy-value",
      E2E_DATABASE_INSTANCE_ID: FIXED_IDENTITY.instanceId,
      E2E_API_URL: "https://api.qa-disposable.example.test",
      E2E_WEB_URL: "https://app.qa-disposable.example.test",
      E2E_AUTH_COOKIE_DOMAIN: ".qa-disposable.example.test",
    };
    let spawnCalls = 0;
    let janitorCalls = 0;
    await assert.rejects(
      runIsolatedE2eForPlatformTest("linux", [], {
        env,
        spawnFn: () => {
          spawnCalls += 1;
          assert.fail("remote Playwright must not spawn after abort");
        },
        remoteDatabasePreflight: async () => ({
          isRemote: true,
          apiUrl: env.E2E_API_URL,
          instanceId: env.E2E_DATABASE_INSTANCE_ID,
        }),
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              status: "bound",
              instanceId: env.E2E_DATABASE_INSTANCE_ID,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        beforePlaywrightSpawn: ({ mode, requestShutdown }) => {
          assert.equal(mode, "remote-disposable");
          requestShutdown("TIMEOUT");
        },
        remoteDatabaseJanitor: async () => {
          janitorCalls += 1;
        },
      }),
      /TIMEOUT; bounded non-local cleanup completed/,
    );
    assert.equal(spawnCalls, 0);
    assert.equal(janitorCalls, 1);
  });

  await t.test("deployed-qa", async () => {
    let spawnCalls = 0;
    await assert.rejects(
      runIsolatedE2e([], {
        env: {
          E2E_DEPLOYED_QA: "true",
          E2E_WEB_URL: "https://qa.example.test",
          E2E_API_URL: "https://api.qa.example.test",
        },
        spawnFn: () => {
          spawnCalls += 1;
          assert.fail("deployed Playwright must not spawn after abort");
        },
        beforePlaywrightSpawn: ({ mode, requestShutdown }) => {
          assert.equal(mode, "deployed-qa");
          requestShutdown("TIMEOUT");
        },
      }),
      /TIMEOUT; bounded non-local cleanup completed/,
    );
    assert.equal(spawnCalls, 0);
  });

  await t.test("local-disposable", async () => {
    const commands = [];
    let playwrightSpawnCalls = 0;
    const commandRunner = async (command, args, options = {}) => {
      commands.push({ command, args, signal: options.signal });
      if (command === "docker") {
        if (args.includes("config")) {
          return {
            code: 0,
            stdout: JSON.stringify(renderedCompose()),
            stderr: "",
          };
        }
        if (args.includes("context")) {
          return {
            code: 0,
            stdout: '"unix:///var/run/docker.sock"',
            stderr: "",
          };
        }
        if (args.includes("buildx")) {
          return {
            code: 0,
            stdout: "Name: default\nDriver: docker\n",
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      options.signal?.throwIfAborted();
      playwrightSpawnCalls += 1;
      return { code: 0, stdout: "", stderr: "" };
    };

    await assert.rejects(
      runIsolatedE2e([], {
        ...TEST_RUNTIME_ATTESTATION_STUBS,
        env: {},
        identity: FIXED_IDENTITY,
        buildContextCreator: async () => {},
        portChecker: async () => {},
        runCommand: commandRunner,
        waitOptions: {
          fetchFn: async () => new Response("", { status: 200 }),
        },
        beforePlaywrightSpawn: ({ mode, requestShutdown }) => {
          assert.equal(mode, "local-disposable");
          requestShutdown("TIMEOUT");
        },
      }),
      /TIMEOUT; stack cleanup completed/,
    );
    assert.equal(playwrightSpawnCalls, 0);
    const down = commands.find((entry) => entry.args.includes("down"));
    assert.ok(
      down,
      "aborted local Playwright must still run exact Compose down",
    );
    assert.equal(down.signal, undefined);
    const residueChecks = commands.filter(
      (entry) =>
        entry.args.includes("--filter") ||
        (entry.args.includes("image") && entry.args.includes("ls")),
    );
    assert.equal(residueChecks.length, 6);
    assert.equal(
      residueChecks.every((entry) => entry.signal === undefined),
      true,
    );
  });
});

test("native Windows rejects remote-disposable before database or API authority", async () => {
  const env = {
    E2E_EXECUTION_MODE: "remote-disposable",
    E2E_READINESS_API_KEY: "remote-readiness-key-with-enough-entropy",
    E2E_JWT_SECRET: "remote-jwt-secret-with-enough-entropy-value",
  };
  let preflightCalls = 0;
  let commandCalls = 0;
  let janitorCalls = 0;
  await assert.rejects(
    runIsolatedE2eForPlatformTest("win32", [], {
      env,
      remoteDatabasePreflight: async () => {
        preflightCalls += 1;
        return { isRemote: true };
      },
      runCommand: async () => {
        commandCalls += 1;
        return { code: 0 };
      },
      remoteDatabaseJanitor: async () => {
        janitorCalls += 1;
      },
    }),
    /forbidden on native Windows.*Job Object/,
  );
  assert.equal(preflightCalls, 0);
  assert.equal(commandCalls, 0);
  assert.equal(janitorCalls, 0);
});

test("remote-disposable mode requires both independent preflights and never invokes Compose", async () => {
  const commands = [];
  const env = {
    E2E_EXECUTION_MODE: "remote-disposable",
    E2E_READINESS_API_KEY: "remote-readiness-key-with-enough-entropy",
    E2E_JWT_SECRET: "remote-jwt-secret-with-enough-entropy-value",
    E2E_DATABASE_INSTANCE_ID: FIXED_IDENTITY.instanceId,
    E2E_API_URL: "https://api.qa-disposable.example.test",
    E2E_WEB_URL: "https://app.qa-disposable.example.test",
    E2E_AUTH_COOKIE_DOMAIN: ".qa-disposable.example.test",
  };
  let directPreflightCount = 0;
  let janitorCount = 0;
  let bindingRequest;
  const result = await runIsolatedE2eForPlatformTest(
    "linux",
    ["tests/auth.spec.ts"],
    {
      env,
      remoteDatabasePreflight: async (receivedEnv) => {
        directPreflightCount += 1;
        assert.equal(receivedEnv, env);
        return {
          isRemote: true,
          apiUrl: env.E2E_API_URL,
          instanceId: env.E2E_DATABASE_INSTANCE_ID,
        };
      },
      fetchFn: async (url, init) => {
        bindingRequest = { url, init };
        return new Response(
          JSON.stringify({
            status: "bound",
            instanceId: env.E2E_DATABASE_INSTANCE_ID,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
      remoteDatabaseJanitor: async (config, receivedEnv) => {
        janitorCount += 1;
        assert.equal(config.isRemote, true);
        assert.equal(receivedEnv, env);
      },
    },
  );

  assert.equal(result, 0);
  assert.equal(directPreflightCount, 1);
  assert.equal(janitorCount, 1);
  assert.equal(
    bindingRequest.url,
    `${env.E2E_API_URL}/api/v1/health/e2e-database-identity`,
  );
  assert.equal(
    bindingRequest.init.headers["x-charitypilot-readiness-key"],
    env.E2E_READINESS_API_KEY,
  );
  assert.equal(commands.length, 1);
  assert.equal(
    commands.some(
      (command) => command.includes("docker") || command.includes("compose"),
    ),
    false,
  );
  assert.ok(commands[0].includes("tests/auth.spec.ts"));
});

test("outer remote janitor acquires the suite lease before reset and always releases it", async () => {
  const config = {
    isRemote: true,
    instanceId: FIXED_IDENTITY.instanceId,
    apiUrl: "https://api.qa-disposable.example.test",
    databaseUrl:
      "postgresql://charitypilot_e2e_runner:remote-password-secret@db.qa-disposable.example.test:5432/charitypilot_e2e_disposable",
  };
  const env = {
    E2E_DATABASE_URL: config.databaseUrl,
    E2E_READINESS_API_KEY: "remote-readiness-key-with-enough-entropy",
    E2E_JWT_SECRET: "remote-jwt-secret-with-enough-entropy-value",
  };
  const calls = [];
  let receivedResetTables;
  const client = {
    connect: async () => {
      calls.push("connect");
    },
    end: async () => {
      calls.push("end");
    },
  };

  await janitorRemoteDisposableDatabase(config, env, {
    clientFactory: () => client,
    queryAndAssertDatabaseIdentity: async () => {
      calls.push("identity");
    },
    acquireRemoteSuiteAdvisoryLeaseBounded: async () => {
      calls.push("lease");
    },
    verifyApiDatabaseBinding: async () => {
      calls.push("binding");
    },
    resetDisposableDatabase: async (_client, _config, tables) => {
      calls.push("reset");
      receivedResetTables = tables;
    },
    releaseRemoteSuiteAdvisoryLease: async () => {
      calls.push("release");
    },
  });

  assert.deepEqual(calls, [
    "connect",
    "identity",
    "lease",
    "binding",
    "reset",
    "binding",
    "release",
    "end",
  ]);
  assert.equal(Object.isFrozen(receivedResetTables), true);
  assert.ok(receivedResetTables.includes("Organisation"));
  assert.ok(receivedResetTables.includes("StripeWebhookEvent"));

  const failedCalls = [];
  await assert.rejects(
    janitorRemoteDisposableDatabase(config, env, {
      clientFactory: () => ({
        connect: async () => {
          failedCalls.push("connect");
        },
        end: async () => {
          failedCalls.push("end");
        },
      }),
      queryAndAssertDatabaseIdentity: async () => {
        failedCalls.push("identity");
      },
      acquireRemoteSuiteAdvisoryLeaseBounded: async () => {
        failedCalls.push("lease");
        throw new Error(
          `contended ${config.databaseUrl} ${env.E2E_READINESS_API_KEY}`,
        );
      },
      verifyApiDatabaseBinding: async () => {
        failedCalls.push("binding");
      },
      resetDisposableDatabase: async () => {
        failedCalls.push("reset");
      },
      releaseRemoteSuiteAdvisoryLease: async () => {
        failedCalls.push("release");
      },
    }),
    (error) => {
      assert.match(error.message, /outer cleanup failed closed/);
      assert.doesNotMatch(
        error.message,
        /remote-password-secret|remote-readiness-key-with-enough-entropy/,
      );
      return true;
    },
  );
  assert.deepEqual(failedCalls, ["connect", "identity", "lease", "end"]);
});

test("remote runner invokes the outer janitor after a Playwright failure and makes janitor failure red", async () => {
  const env = {
    E2E_EXECUTION_MODE: "remote-disposable",
    E2E_READINESS_API_KEY: "remote-readiness-key-with-enough-entropy",
    E2E_JWT_SECRET: "remote-jwt-secret-with-enough-entropy-value",
    E2E_DATABASE_INSTANCE_ID: FIXED_IDENTITY.instanceId,
    E2E_API_URL: "https://api.qa-disposable.example.test",
    E2E_WEB_URL: "https://app.qa-disposable.example.test",
    E2E_AUTH_COOKIE_DOMAIN: ".qa-disposable.example.test",
  };
  const config = {
    isRemote: true,
    apiUrl: env.E2E_API_URL,
    instanceId: env.E2E_DATABASE_INSTANCE_ID,
  };
  let janitorCount = 0;
  await assert.rejects(
    runIsolatedE2eForPlatformTest("linux", [], {
      env,
      remoteDatabasePreflight: async () => config,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            status: "bound",
            instanceId: env.E2E_DATABASE_INSTANCE_ID,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      runCommand: async () => {
        throw new Error("synthetic Playwright failure");
      },
      remoteDatabaseJanitor: async () => {
        janitorCount += 1;
      },
    }),
    /synthetic Playwright failure/,
  );
  assert.equal(janitorCount, 1);

  await assert.rejects(
    runIsolatedE2eForPlatformTest("linux", [], {
      env,
      remoteDatabasePreflight: async () => config,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            status: "bound",
            instanceId: env.E2E_DATABASE_INSTANCE_ID,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      remoteDatabaseJanitor: async () => {
        throw new Error("synthetic janitor failure");
      },
    }),
    /non-local cleanup failed closed.*synthetic janitor failure/,
  );
});

test("unproven remote child-tree shutdown skips the destructive janitor and requires manual recovery", async () => {
  const env = {
    E2E_EXECUTION_MODE: "remote-disposable",
    E2E_READINESS_API_KEY: "remote-readiness-key-with-enough-entropy",
    E2E_JWT_SECRET: "remote-jwt-secret-with-enough-entropy-value",
    E2E_DATABASE_INSTANCE_ID: FIXED_IDENTITY.instanceId,
    E2E_API_URL: "https://api.qa-disposable.example.test",
    E2E_WEB_URL: "https://app.qa-disposable.example.test",
    E2E_AUTH_COOKIE_DOMAIN: ".qa-disposable.example.test",
  };
  const child = Object.assign(new EventEmitter(), {
    pid: 47,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  let requestShutdown;
  let janitorCalls = 0;
  await assert.rejects(
    runIsolatedE2eForPlatformTest("linux", [], {
      env,
      spawnFn: () => {
        queueMicrotask(() => requestShutdown("TIMEOUT"));
        return child;
      },
      childShutdownOptions: {
        platform: "linux",
        termGraceMs: 1,
        killGraceMs: 1,
        probeFn: async () => false,
        terminateFn: async () => {},
      },
      remoteDatabasePreflight: async () => ({
        isRemote: true,
        apiUrl: env.E2E_API_URL,
        instanceId: env.E2E_DATABASE_INSTANCE_ID,
      }),
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            status: "bound",
            instanceId: env.E2E_DATABASE_INSTANCE_ID,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      beforePlaywrightSpawn: (lifecycle) => {
        requestShutdown = lifecycle.requestShutdown;
      },
      remoteDatabaseJanitor: async () => {
        janitorCalls += 1;
      },
    }),
    /shutdown unproven.*manual process and database recovery.*janitor was skipped/,
  );
  assert.equal(janitorCalls, 0);
});

test("unproven local child-tree shutdown skips Docker cleanup and preserves recovery material", async () => {
  let requestShutdown;
  let nextPid = 1000;
  let cleanupSpawnCalls = 0;
  let runnerTempRoot;
  const spawnFn = (command, args) => {
    const child = Object.assign(new EventEmitter(), {
      pid: nextPid++,
      exitCode: null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const isPlaywright = command !== "docker";
    child.syntheticPlaywright = isPlaywright;
    if (isPlaywright) {
      queueMicrotask(() => requestShutdown("TIMEOUT"));
      return child;
    }

    let stdout = "";
    if (args.includes("config")) stdout = JSON.stringify(renderedCompose());
    else if (args.includes("context")) {
      stdout = '"unix:///var/run/docker.sock"';
    } else if (args.includes("buildx")) {
      stdout = "Name: default\nDriver: docker\n";
    }
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      child.exitCode = 0;
      child.emit("close", 0, null);
    });
    return child;
  };

  try {
    await assert.rejects(
      runIsolatedE2e([], {
        ...TEST_RUNTIME_ATTESTATION_STUBS,
        env: {},
        identity: FIXED_IDENTITY,
        buildContextCreator: async () => {},
        portChecker: async () => {},
        spawnFn,
        cleanupSpawnFn: () => {
          cleanupSpawnCalls += 1;
          assert.fail(
            "cleanup must not start without exact tree absence proof",
          );
        },
        childShutdownOptions: {
          platform: "linux",
          termGraceMs: 1,
          killGraceMs: 1,
          probeFn: async (candidate) => !candidate.syntheticPlaywright,
          terminateFn: async () => {},
        },
        waitOptions: {
          fetchFn: async () => new Response("", { status: 200 }),
        },
        onTempRoot: (value) => {
          runnerTempRoot = value;
        },
        beforePlaywrightSpawn: (lifecycle) => {
          requestShutdown = lifecycle.requestShutdown;
        },
      }),
      (error) => {
        assert.match(
          error.message,
          /absence was not proved; Docker cleanup was not started.*manual process\/stack recovery/,
        );
        assert.equal(error.recoveryDirectory, runnerTempRoot);
        return true;
      },
    );
    assert.equal(cleanupSpawnCalls, 0);
    assert.equal(existsSync(runnerTempRoot), true);
  } finally {
    if (runnerTempRoot) {
      await rm(runnerTempRoot, { recursive: true, force: true });
    }
  }
});

test("API binding preflight rejects copied, mismatched, or over-broad response envelopes", async () => {
  const config = {
    apiUrl: "https://api.qa-disposable.example.test",
    instanceId: FIXED_IDENTITY.instanceId,
  };
  const env = {
    E2E_READINESS_API_KEY: "remote-readiness-key-with-enough-entropy",
  };

  for (const body of [
    { status: "bound", instanceId: "d91175fe-d317-4633-aeaa-f0045019067c" },
    { status: "bound", instanceId: config.instanceId, extra: true },
    { status: "ready", instanceId: config.instanceId },
  ]) {
    await assert.rejects(
      verifyApiDatabaseBinding(
        config,
        env,
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
      /not bound to the independently verified disposable database instance/,
    );
  }
});

test("deployed QA refuses every destructive execution-mode and database identity input", async () => {
  await assert.rejects(
    runIsolatedE2e([], {
      env: {
        E2E_DEPLOYED_QA: "true",
        E2E_EXECUTION_MODE: "local-disposable",
        E2E_WEB_URL: "https://app.charitypilot.ie",
        E2E_API_URL: "https://api.charitypilot.ie",
      },
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    }),
    /Deployed QA is non-destructive and refuses database\/reset variables: E2E_EXECUTION_MODE/,
  );
});

test("standalone compose and bootstrap SQL contain the exact non-personal isolation contract", () => {
  const compose = readFileSync(join(ROOT, "compose.e2e.yml"), "utf8");
  const init = readFileSync(
    join(ROOT, "e2e", "docker", "init-disposable-database.sql"),
    "utf8",
  );
  const dockerfile = readFileSync(
    join(ROOT, "e2e", "docker", "Dockerfile"),
    "utf8",
  );
  const dockerignore = readFileSync(join(ROOT, ".dockerignore"), "utf8");
  const rootPackage = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  const playwrightConfig = readFileSync(
    join(ROOT, "e2e", "playwright.config.ts"),
    "utf8",
  );
  const personalConfig = readFileSync(
    join(ROOT, "e2e", "personal-local.config.ts"),
    "utf8",
  );
  const fixturesSource = readFileSync(join(ROOT, "e2e", "fixtures.ts"), "utf8");
  const apiClient = readFileSync(
    join(ROOT, "apps", "web", "src", "lib", "api.ts"),
    "utf8",
  );
  const documentsSpec = readFileSync(
    join(ROOT, "e2e", "tests", "documents.spec.ts"),
    "utf8",
  );
  const personalSpec = readFileSync(
    join(ROOT, "e2e", "tests", "personal-local-readiness.spec.ts"),
    "utf8",
  );
  const isolatedSpecSources = readdirSync(join(ROOT, "e2e", "tests"))
    .filter(
      (name) =>
        name.endsWith(".spec.ts") &&
        name !== "personal-local-readiness.spec.ts",
    )
    .map((name) => readFileSync(join(ROOT, "e2e", "tests", name), "utf8"))
    .join("\n");
  const manualContextSpecs = [
    "auth-session.spec.ts",
    "authz.spec.ts",
    "deadlines-team.spec.ts",
  ]
    .map((name) => readFileSync(join(ROOT, "e2e", "tests", name), "utf8"))
    .join("\n");

  assert.doesNotMatch(
    compose,
    /charitypilot-data|^\s+container_name:|^\s+restart:/m,
  );
  assert.match(
    compose,
    /Standalone only: never layer this file over compose\.yml or compose\.local\.yml/,
  );
  assert.match(compose, /published: "55434"\s+host_ip: 127\.0\.0\.1/);
  assert.match(compose, /published: "3302"/);
  assert.match(compose, /published: "3303"/);
  const dbCompose = compose.slice(
    compose.indexOf("  db:"),
    compose.indexOf("\n  api:"),
  );
  const apiCompose = compose.slice(
    compose.indexOf("  api:"),
    compose.indexOf("\n  web:"),
  );
  const webCompose = compose.slice(
    compose.indexOf("  web:"),
    compose.indexOf("\n  gateway:"),
  );
  const gatewayCompose = compose.slice(
    compose.indexOf("  gateway:"),
    compose.indexOf("\nnetworks:"),
  );
  for (const [serviceName, serviceCompose] of [
    ["db", dbCompose],
    ["api", apiCompose],
    ["web", webCompose],
  ]) {
    assert.doesNotMatch(
      serviceCompose,
      /^\s+ports:/m,
      `${serviceName} must remain internal-only`,
    );
    assert.match(
      serviceCompose,
      new RegExp(
        `aliases:\\s*\\n\\s+- ${serviceName}\\.charitypilot-e2e\\.invalid`,
      ),
      `${serviceName} must have its unique reserved network alias`,
    );
  }
  assert.match(
    gatewayCompose,
    /target: 55434[\s\S]*target: 3302[\s\S]*target: 3303/,
  );
  assert.match(gatewayCompose, /networks:\s*\n\s+- e2e\s*\n\s+- edge/);
  assert.doesNotMatch(gatewayCompose, /aliases:/);
  assert.doesNotMatch(
    gatewayCompose,
    /^\s+environment:|^\s+env_file:|^\s+secrets:|^\s+volumes:/m,
  );
  assert.match(gatewayCompose, /\/proc\/net\/tcp/);
  assert.match(
    gatewayCompose,
    /00000000:D88A[\s\S]*00000000:0CE6[\s\S]*00000000:0CE7/,
  );
  assert.match(compose, /SEED_LOCAL_ADMIN: "false"/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.doesNotMatch(compose, /type:\s*bind|source:\s*\./);
  assert.match(compose, /\/var\/lib\/postgresql\/data:[^\n]*size=1024m/);
  assert.match(
    compose,
    /\/var\/lib\/charitypilot-e2e-documents:[^\n]*size=256m/,
  );
  assert.doesNotMatch(
    webCompose,
    /\/app\/apps\/web\/\.next|next dev|WATCHPACK_POLLING|NODE_OPTIONS/,
  );
  assert.match(
    webCompose,
    /command:\s*\n\s+- node\s*\n\s+- apps\/web\/server\.mjs/,
  );
  assert.match(webCompose, /NODE_ENV: production/);
  assert.match(webCompose, /NEXT_PUBLIC_API_URL: http:\/\/127\.0\.0\.1:3302/);
  assert.match(
    webCompose,
    /NEXT_PUBLIC_CHARITYPILOT_E2E_MODE: local-disposable/,
  );
  assert.match(webCompose, /CHARITYPILOT_INTERNAL_API_URL: http:\/\/api:3302/);
  assert.match(webCompose, /fetch\('http:\/\/127\.0\.0\.1:3303\/'/);
  assert.match(apiCompose, /NODE_ENV: development/);
  assert.doesNotMatch(compose, /LocalAdmin123|charitypilot_dev/);

  assert.match(
    init,
    /NOSUPERUSER[\s\S]*NOCREATEDB[\s\S]*NOCREATEROLE[\s\S]*NOREPLICATION[\s\S]*NOBYPASSRLS/,
  );
  assert.match(
    init,
    /COMMENT ON DATABASE charitypilot_e2e_disposable IS\s+'CHARITYPILOT_DISPOSABLE_E2E_DATABASE_V1'/,
  );
  assert.match(init, /CREATE SCHEMA charitypilot_e2e_guard/);
  assert.match(
    init,
    /GRANT SELECT ON TABLE charitypilot_e2e_guard\.database_identity/,
  );
  assert.match(init, /ALTER ROLE charitypilot_e2e_bootstrap NOLOGIN/);
  assert.doesNotMatch(init, /PASSWORD\s+'[^:]/);

  assert.match(
    dockerfile,
    /FROM postgres:16\.4-alpine@sha256:[a-f0-9]{64} AS database/,
  );
  assert.match(
    dockerfile,
    /FROM node:22-alpine@sha256:[a-f0-9]{64} AS app-dependencies/,
  );
  assert.match(
    dockerfile,
    /FROM node:22-alpine@sha256:[a-f0-9]{64} AS gateway/,
  );
  const gatewayTarget = dockerfile.slice(
    dockerfile.indexOf(" AS gateway"),
    dockerfile.indexOf(" AS app-dependencies"),
  );
  assert.match(
    gatewayTarget,
    /COPY --chown=root:root --chmod=0444 e2e\/docker\/tcp-gateway\.mjs \/gateway\/tcp-gateway\.mjs/,
  );
  assert.doesNotMatch(gatewayTarget, /COPY\s+\.\s|npm\s|\bARG\b|\bENV\b/);
  assert.match(
    dockerfile,
    /Forbidden private path entered the isolated E2E build context/,
  );
  assert.match(dockerfile, /COPY --chown=node:node \. \./);
  assert.match(dockerfile, /-type d -name 'node_modules' -prune -o/);
  assert.match(
    dockerfile,
    /NODE_ENV=production\s+\\\s*\n\s*NEXT_PUBLIC_API_URL=http:\/\/127\.0\.0\.1:3302\s+\\\s*\n\s*NEXT_PUBLIC_CHARITYPILOT_E2E_MODE=local-disposable\s+\\\s*\n\s*npm run build -w @charitypilot\/web/,
  );
  assert.match(dockerfile, /test -s apps\/web\/\.next\/BUILD_ID/);
  assert.match(dockerfile, /rm -rf apps\/web\/\.next\/cache/);
  assert.match(dockerfile, /test ! -e apps\/web\/\.next\/cache/);
  assert.match(dockerfile, /ENV NODE_ENV=development/);
  assert.doesNotMatch(
    dockerfile,
    /\bARG\s+(?:NODE_ENV|NEXT_PUBLIC_API_URL|NEXT_PUBLIC_CHARITYPILOT_E2E_MODE)\b/,
  );
  assert.doesNotMatch(dockerfile, /! -name '\.env\.production\.example'/);
  for (const pattern of [
    ".git",
    ".env",
    "**/.env",
    ".charitypilot-backups/",
    ".charitypilot-launch-evidence/",
    ".charitypilot-local-storage/",
    ".charitypilot-readiness-test-storage/",
    ".agents/",
    ".claude/",
    ".codex/",
    "**/.codex/",
  ]) {
    assert.ok(
      dockerignore.split(/\r?\n/u).includes(pattern),
      `.dockerignore must exclude ${pattern}`,
    );
  }
  assert.doesNotMatch(dockerignore, /^!\.env/m);
  assert.ok(
    dockerignore.split(/\r?\n/u).includes("!e2e/docker/tcp-gateway.mjs"),
  );
  assert.equal(rootPackage.scripts["pretest:e2e"], "npm run test:e2e:contract");
  assert.match(
    rootPackage.scripts["test:e2e:contract"],
    /run-isolated-e2e\.test\.mjs/,
  );
  assert.match(
    rootPackage.scripts["test:e2e:contract"],
    /isolated-e2e-runtime-attestation\.test\.mjs/,
  );
  assert.match(
    rootPackage.scripts["test:e2e:contract"],
    /browser-origin-policy\.test\.cjs/,
  );
  assert.match(
    rootPackage.scripts["test:e2e:contract"],
    /database-safety\.test\.cjs/,
  );
  assert.match(
    rootPackage.scripts["test:e2e:contract"],
    /tcp-gateway\.test\.mjs/,
  );

  assert.match(
    playwrightConfig,
    /testIgnore:\s*\/personal-local-readiness\\\.spec\\\.ts\//,
  );
  assert.match(playwrightConfig, /serviceWorkers:\s*'block'/);
  assert.match(
    personalConfig,
    /testMatch:\s*\/personal-local-readiness\\\.spec\\\.ts\//,
  );
  assert.match(
    apiClient,
    /getApiBaseUrl\(\{\s*NODE_ENV:\s*process\.env\.NODE_ENV,\s*NEXT_PUBLIC_API_URL:\s*process\.env\.NEXT_PUBLIC_API_URL,\s*NEXT_PUBLIC_CHARITYPILOT_E2E_MODE:\s*process\.env\.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE,?\s*\}\)/,
  );
  assert.doesNotMatch(apiClient, /const API_URL = getApiBaseUrl\(\);/);
  assert.match(fixturesSource, /async function openFencedContext/);
  assert.equal(
    (fixturesSource.match(/browser\.newContext\(/g) ?? []).length,
    1,
  );
  assert.match(fixturesSource, /baseURL:\s*browserOriginFence\.webOrigin/);
  assert.match(fixturesSource, /serviceWorkers:\s*'block'/);
  assert.match(fixturesSource, /await browserOriginFence\.install\(context\)/);
  assert.match(
    fixturesSource,
    /browserOriginFence\.assertNoViolationsSince\(checkpoint\)/,
  );
  assert.doesNotMatch(
    manualContextSpecs,
    /browser\.newContext\(|browser\.newPage\(/,
  );
  assert.doesNotMatch(
    isolatedSpecSources,
    /browser\.newContext\(|browser\.newPage\(/,
  );
  assert.doesNotMatch(
    isolatedSpecSources,
    /\.(?:route|unroute|routeWebSocket|unrouteAll)\(/,
  );
  assert.doesNotMatch(
    isolatedSpecSources,
    /\.request\.(?:get|post|put|patch|delete)\(/,
  );
  assert.doesNotMatch(
    isolatedSpecSources,
    /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*['"]@playwright\/test['"]/,
  );
  assert.doesNotMatch(
    documentsSpec,
    /\.request\.(?:get|post|put|patch|delete)\(/,
  );
  assert.match(documentsSpec, /ownerPage\.waitForResponse\([\s\S]*\/api\\\/v1\\\/documents\\\/\[\^\/\]\+\\\/download\$/);
  assert.match(documentsSpec, /ownerPage\.waitForEvent\(['"]download['"]\)/);
  assert.match(documentsSpec, /await download\.path\(\)/);
  assert.doesNotMatch(documentsSpec, /ownerPage\.evaluate[\s\S]*fetch\(/);
  assert.doesNotMatch(
    personalSpec,
    /from '\.\.\/fixtures'|from '\.\.\/helpers\/navigation'/,
  );
  assert.match(personalSpec, /from '@playwright\/test'/);

  const globalSetup = readFileSync(
    join(ROOT, "e2e", "global-setup.ts"),
    "utf8",
  );
  const setupBody = globalSetup.slice(
    globalSetup.indexOf("export default async function globalSetup"),
  );
  assert.match(
    setupBody,
    /await verifyDisposableDatabaseIdentity\(\)[\s\S]*await verifyApiDatabaseBinding\(\)[\s\S]*await resetDb\(\)[\s\S]*await verifyApiDatabaseBinding\(\)[\s\S]*await warmRoutes\(\)/,
  );
  assert.match(
    setupBody,
    /await acquireRemoteDisposableSuiteLease\(\)[\s\S]*await verifyApiDatabaseBinding\(\)[\s\S]*await remoteLease\.reset\(\)/,
  );
  const remoteSetupBranch = setupBody.slice(
    setupBody.indexOf("if (disposableConfig?.isRemote)"),
    setupBody.indexOf(
      "} else {",
      setupBody.indexOf("if (disposableConfig?.isRemote)"),
    ),
  );
  assert.ok(
    remoteSetupBranch.indexOf("await verifyApiDatabaseBinding()") <
      remoteSetupBranch.indexOf("remoteDestructiveAuthorized = true") &&
      remoteSetupBranch.indexOf("remoteDestructiveAuthorized = true") <
        remoteSetupBranch.indexOf("await remoteLease.reset()"),
    "remote reset authority must be granted only after the initial API binding canary succeeds",
  );
  const remoteFailureCleanup = setupBody.slice(
    setupBody.indexOf("if (remoteLease) {"),
    setupBody.indexOf("const safeMessage"),
  );
  assert.match(
    remoteFailureCleanup,
    /if \(remoteDestructiveAuthorized\) \{[\s\S]*finalResetVerifyAndRelease\(remoteLease\)[\s\S]*\} else \{[\s\S]*remoteLease\.release\(\)/,
    "an initial binding-canary failure must release the lease without resetting the remote database",
  );
  assert.match(
    setupBody,
    /return async \(\) => \{[\s\S]*finalResetVerifyAndRelease\(remoteLease\)/,
  );
  const finalizer = globalSetup.slice(
    globalSetup.indexOf("async function finalResetVerifyAndRelease"),
    globalSetup.indexOf("async function warmFetch"),
  );
  assert.ok(
    finalizer.indexOf("await lease.reset()") <
      finalizer.indexOf("await verifyApiDatabaseBinding()") &&
      finalizer.indexOf("await verifyApiDatabaseBinding()") <
        finalizer.indexOf("await lease.release()"),
  );
  assert.match(globalSetup, /Object\.keys\(record\)\.sort\(\)/);
  assert.match(globalSetup, /x-charitypilot-readiness-key/);
  assert.match(globalSetup, /value\.length < 32/);

  const releaseReady = readFileSync(
    join(ROOT, "scripts", "release-ready.mjs"),
    "utf8",
  );
  const isolatedRunner = readFileSync(
    join(ROOT, "scripts", "run-isolated-e2e.mjs"),
    "utf8",
  );
  assert.match(releaseReady, /detached: process\.platform !== 'win32'/);
  assert.match(releaseReady, /process\.kill\(-pid, 'SIGKILL'\)/);
  assert.match(releaseReady, /RELEASE_READY_E2E_TIMEOUT_MS \+ 1800000/);
  assert.match(
    releaseReady,
    /positiveIntEnv\('RELEASE_READY_E2E_TIMEOUT_MS', 2400000\)/,
  );
  assert.match(releaseReady, /'E2E_GATEWAY_IMAGE'/);
  assert.match(
    isolatedRunner,
    /timeoutMs: options\.waitOptions\?\.timeoutMs \?\? 600_000/,
  );
  assert.match(isolatedRunner, /timeoutMs: 600_000/);
  assert.match(
    isolatedRunner,
    /const composeSnapshotFile = join\(tempRoot, ["']compose\.e2e\.snapshot\.yml["']\)/,
  );
  assert.match(
    isolatedRunner,
    /new TextDecoder\(["']utf-8["'],\s*\{\s*fatal:\s*true,\s*ignoreBOM:\s*true,?\s*\}\)/,
  );
  assert.match(isolatedRunner, /["']--project-directory["'],\s*ROOT/);
  assert.match(isolatedRunner, /composeSnapshotFile,\s*["']down["']/);

  const e2eWorkflow = readFileSync(
    join(ROOT, ".github", "workflows", "e2e.yml"),
    "utf8",
  );
  const workflowTimeoutMatch = e2eWorkflow.match(/timeout-minutes:\s*(\d+)/);
  const runnerTimeoutMatch = e2eWorkflow.match(
    /E2E_RUNNER_TIMEOUT_MS:\s*'(\d+)'/,
  );
  assert.ok(
    workflowTimeoutMatch,
    "E2E workflow must declare a finite job timeout",
  );
  assert.ok(
    runnerTimeoutMatch,
    "E2E workflow must declare a finite runner timeout",
  );
  const workflowTimeoutMs = Number(workflowTimeoutMatch[1]) * 60_000;
  const runnerTimeoutMs = Number(runnerTimeoutMatch[1]);
  assert.ok(
    workflowTimeoutMs - runnerTimeoutMs >= 30 * 60_000,
    "E2E workflow must reserve at least 30 minutes beyond the runner timeout for setup and fail-closed cleanup",
  );
  assert.match(e2eWorkflow, /- 'tsconfig\.base\.json'/);
  assert.match(
    e2eWorkflow,
    /- 'scripts\/isolated-e2e-runtime-attestation\.mjs'/,
  );
  assert.match(e2eWorkflow, /run: npm run test:e2e:contract/);

  const ciWorkflow = readFileSync(
    join(ROOT, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  assert.match(
    ciWorkflow,
    /cache-dependency-path: \|\s+package-lock\.json\s+e2e\/package-lock\.json/,
  );
});
