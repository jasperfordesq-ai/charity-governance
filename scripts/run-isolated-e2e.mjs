#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  attestBuiltImages,
  attestRunningContainers,
} from "./isolated-e2e-runtime-attestation.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const COMPOSE_FILE = join(ROOT, "compose.e2e.yml");
export const BUILD_CONTEXT_MANIFEST = Object.freeze([
  { path: "package.json", type: "file" },
  { path: "package-lock.json", type: "file" },
  { path: "tsconfig.base.json", type: "file" },
  { path: "apps/api/package.json", type: "file" },
  { path: "apps/api/tsconfig.json", type: "file" },
  { path: "apps/api/prisma.config.ts", type: "file" },
  { path: "apps/api/src", type: "directory", allowedExtensions: [".ts"] },
  {
    path: "apps/api/prisma",
    type: "directory",
    allowedExtensions: [".json", ".prisma", ".sql", ".toml", ".ts"],
  },
  { path: "apps/web/package.json", type: "file" },
  { path: "apps/web/server.mjs", type: "file" },
  { path: "apps/web/tsconfig.json", type: "file" },
  { path: "apps/web/next-env.d.ts", type: "file" },
  { path: "apps/web/next.config.ts", type: "file" },
  { path: "apps/web/postcss.config.mjs", type: "file" },
  { path: "apps/web/tailwind.config.js", type: "file" },
  {
    path: "apps/web/src",
    type: "directory",
    allowedExtensions: [".css", ".ts", ".tsx"],
  },
  {
    path: "apps/web/public",
    type: "directory",
    optional: true,
    allowedExtensions: [
      ".avif",
      ".gif",
      ".ico",
      ".jpeg",
      ".jpg",
      ".json",
      ".png",
      ".svg",
      ".txt",
      ".webp",
      ".woff",
      ".woff2",
      ".xml",
    ],
  },
  { path: "packages/shared/package.json", type: "file" },
  { path: "packages/shared/tsconfig.json", type: "file" },
  {
    path: "packages/shared/src",
    type: "directory",
    allowedExtensions: [".ts"],
  },
  { path: "scripts/clean-next-export.cjs", type: "file" },
  { path: "scripts/next-build-fs-retry.cjs", type: "file" },
  { path: "e2e/docker/Dockerfile", type: "file" },
  { path: "e2e/docker/init-disposable-database.sql", type: "file" },
  { path: "e2e/docker/tcp-gateway.mjs", type: "file" },
]);
export const LOCAL_CONTRACT = Object.freeze({
  executionMode: "local-disposable",
  destructiveConfirmation: "DELETE_ONLY_CHARITYPILOT_DISPOSABLE_E2E",
  databaseName: "charitypilot_e2e_disposable",
  databaseUser: "charitypilot_e2e_runner",
  databaseHost: "127.0.0.1",
  databasePort: 55434,
  databaseServerPort: 5432,
  databaseSchema: "public",
  applicationName: "charitypilot-e2e-reset",
  databaseComment: "CHARITYPILOT_DISPOSABLE_E2E_DATABASE_V1",
  markerSchema: "charitypilot_e2e_guard",
  markerTable: "database_identity",
  markerVersion: 1,
  markerPurpose: "charitypilot-e2e-disposable",
  apiUrl: "http://127.0.0.1:3302",
  webUrl: "http://127.0.0.1:3303",
});

const LOCAL_PORTS = Object.freeze([
  { name: "PostgreSQL", port: LOCAL_CONTRACT.databasePort },
  { name: "API", port: 3302 },
  { name: "web", port: 3303 },
]);
const EXACT_CHILD_TERM_GRACE_MS = 10_000;
const EXACT_CHILD_KILL_GRACE_MS = 5_000;
const EXACT_CHILD_PROBE_INTERVAL_MS = 25;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const DEFAULT_RUNNER_TIMEOUT_MS = 2_400_000;
const MAX_RUNNER_TIMEOUT_MS = 7_200_000;
const LOCAL_COMPOSE_BUILD_TIMEOUT_MS = 1_500_000;
const LOCAL_RESIDUE_CHECK_TIMEOUT_MS = 120_000;
const REMOTE_JANITOR_TIMEOUTS = Object.freeze({
  connect: 15_000,
  identity: 45_000,
  lease: 30_000,
  binding: 15_000,
  reset: 360_000,
  release: 45_000,
  disconnect: 15_000,
});
const FORBIDDEN_AMBIENT_LOCAL_KEYS = Object.freeze([
  "E2E_ALLOW_LOCAL_DB_RESET",
  "E2E_DATABASE_URL",
  "E2E_DATABASE_INSTANCE_ID",
  "E2E_DESTRUCTIVE_RESET_CONFIRMATION",
  "E2E_REMOTE_DATABASE_RESET_OVERRIDE",
  "E2E_REMOTE_DATABASE_HOST",
  "E2E_DATABASE_SERVER_ADDRESS",
  "E2E_BOOTSTRAP_PASSWORD",
  "E2E_DATABASE_RUNNER_PASSWORD",
  "E2E_JWT_SECRET",
  "E2E_READINESS_API_KEY",
  "E2E_AUTH_COOKIE_DOMAIN",
  "E2E_APP_IMAGE",
  "E2E_DATABASE_IMAGE",
  "E2E_GATEWAY_IMAGE",
  "E2E_BUILD_CONTEXT",
]);
const FORBIDDEN_DOCKER_OVERRIDE_KEYS = Object.freeze([
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "BUILDX_BUILDER",
  "BUILDKIT_HOST",
  "BUILDX_CONFIG",
  "COMPOSE_BAKE",
]);

export function parseRunnerArgs(argv) {
  const playwrightArgs = [];
  let validateOnly = false;
  let passthrough = false;

  for (const arg of argv) {
    if (!passthrough && arg === "--") {
      passthrough = true;
      continue;
    }
    if (!passthrough && arg === "--validate-only") {
      validateOnly = true;
      continue;
    }
    if (!passthrough && arg.startsWith("--runner-")) {
      throw new Error(`Unknown isolated E2E runner option: ${arg}`);
    }
    playwrightArgs.push(arg);
  }

  return { validateOnly, playwrightArgs };
}

export function resolveOverallRunnerTimeoutMs(env = process.env, override) {
  if (override !== undefined) {
    if (
      !Number.isSafeInteger(override) ||
      override < 1 ||
      override > MAX_RUNNER_TIMEOUT_MS
    ) {
      throw new Error(
        "overallTimeoutMs must be a positive bounded integer no greater than two hours.",
      );
    }
    return override;
  }
  const raw = env.E2E_RUNNER_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_RUNNER_TIMEOUT_MS;
  if (!/^\d+$/u.test(raw)) {
    throw new Error(
      "E2E_RUNNER_TIMEOUT_MS must be an explicit positive integer in milliseconds.",
    );
  }
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_RUNNER_TIMEOUT_MS
  ) {
    throw new Error(
      "E2E_RUNNER_TIMEOUT_MS must be between 1 and 7200000 milliseconds.",
    );
  }
  return parsed;
}

function generatedSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function createLocalRunIdentity(overrides = {}) {
  const instanceId = overrides.instanceId ?? randomUUID();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      instanceId,
    )
  ) {
    throw new Error(
      "The generated E2E database instance ID must be a UUID v4.",
    );
  }

  const compactId = instanceId.replaceAll("-", "").toLowerCase();
  const projectName = `charitypilot-e2e-${compactId.slice(0, 20)}`;
  const buildContextDirectory = `.codex-e2e-context-${compactId.slice(0, 20)}`;
  const runnerPassword = overrides.runnerPassword ?? generatedSecret();
  const bootstrapPassword = overrides.bootstrapPassword ?? generatedSecret();
  const jwtSecret = overrides.jwtSecret ?? generatedSecret(48);
  const readinessKey = overrides.readinessKey ?? generatedSecret(32);
  const encodedPassword = encodeURIComponent(runnerPassword);
  const databaseUrl =
    `postgresql://${LOCAL_CONTRACT.databaseUser}:${encodedPassword}` +
    `@${LOCAL_CONTRACT.databaseHost}:${LOCAL_CONTRACT.databasePort}` +
    `/${LOCAL_CONTRACT.databaseName}` +
    `?schema=${LOCAL_CONTRACT.databaseSchema}` +
    `&application_name=${LOCAL_CONTRACT.applicationName}`;

  return {
    projectName,
    appImage: `${projectName}-app:local`,
    databaseImage: `${projectName}-database:local`,
    gatewayImage: `${projectName}-gateway:local`,
    buildContextDirectory,
    buildContextPath: join(ROOT, buildContextDirectory),
    instanceId,
    bootstrapPassword,
    runnerPassword,
    jwtSecret,
    readinessKey,
    databaseUrl,
    composeEnv: {
      E2E_BOOTSTRAP_PASSWORD: bootstrapPassword,
      E2E_DATABASE_RUNNER_PASSWORD: runnerPassword,
      E2E_DATABASE_INSTANCE_ID: instanceId,
      E2E_JWT_SECRET: jwtSecret,
      E2E_READINESS_API_KEY: readinessKey,
      E2E_APP_IMAGE: `${projectName}-app:local`,
      E2E_DATABASE_IMAGE: `${projectName}-database:local`,
      E2E_GATEWAY_IMAGE: `${projectName}-gateway:local`,
      E2E_BUILD_CONTEXT: `./${buildContextDirectory}`,
    },
    playwrightEnv: {
      E2E_EXECUTION_MODE: LOCAL_CONTRACT.executionMode,
      E2E_DESTRUCTIVE_RESET_CONFIRMATION:
        LOCAL_CONTRACT.destructiveConfirmation,
      E2E_DATABASE_INSTANCE_ID: instanceId,
      E2E_DATABASE_URL: databaseUrl,
      E2E_DATABASE_EXPECTED_COMMENT: LOCAL_CONTRACT.databaseComment,
      E2E_DATABASE_EXPECTED_SCHEMA: LOCAL_CONTRACT.databaseSchema,
      E2E_READINESS_API_KEY: readinessKey,
      E2E_JWT_SECRET: jwtSecret,
      E2E_WEB_URL: LOCAL_CONTRACT.webUrl,
      E2E_API_URL: LOCAL_CONTRACT.apiUrl,
    },
    secrets: [
      bootstrapPassword,
      runnerPassword,
      encodeURIComponent(runnerPassword),
      jwtSecret,
      readinessKey,
      databaseUrl,
    ],
  };
}

export function serializeEnvFile(values) {
  return `${Object.entries(values)
    .map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key))
        throw new Error(`Unsafe env key: ${key}`);
      if (!/^[A-Za-z0-9._:/?&=@+-]+$/.test(value)) {
        throw new Error(`Generated value for ${key} is not env-file safe.`);
      }
      return `${key}=${value}`;
    })
    .join("\n")}\n`;
}

function assertSafeBuildContextRelativePath(relativePath) {
  const normalized = String(relativePath).replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith("."),
    )
  ) {
    throw new Error(
      `Unsafe isolated build-context manifest path: ${relativePath}`,
    );
  }
  return segments;
}

function assertSafeBuildContextName(name) {
  const lowered = name.toLowerCase();
  if (
    name.startsWith(".") ||
    lowered === ".env" ||
    lowered.startsWith(".env.")
  ) {
    throw new Error(
      "Hidden or environment files are forbidden from the isolated E2E build context.",
    );
  }
}

async function copyBuildContextNode(
  source,
  destination,
  allowedExtensions = null,
) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) {
    throw new Error(
      "Symbolic links are forbidden from the isolated E2E build context.",
    );
  }
  if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      assertSafeBuildContextName(entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          "Symbolic links are forbidden from the isolated E2E build context.",
        );
      }
      await copyBuildContextNode(
        join(source, entry.name),
        join(destination, entry.name),
        allowedExtensions,
      );
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(
      "Only regular files and directories may enter the isolated E2E build context.",
    );
  }
  if (stat.nlink !== 1) {
    throw new Error(
      "Hard-linked files are forbidden from the isolated E2E build context.",
    );
  }
  if (
    allowedExtensions &&
    !allowedExtensions.includes(extname(source).toLowerCase())
  ) {
    throw new Error(
      "A file with an unapproved extension was rejected from the isolated E2E build context.",
    );
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
}

export async function createIsolatedBuildContext(
  sourceRoot,
  destinationRoot,
  manifest = BUILD_CONTEXT_MANIFEST,
) {
  await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  try {
    for (const entry of manifest) {
      const segments = assertSafeBuildContextRelativePath(entry.path);
      const source = join(sourceRoot, ...segments);
      const destination = join(destinationRoot, ...segments);
      let stat;
      try {
        stat = await lstat(source);
      } catch (error) {
        if (entry.optional && error?.code === "ENOENT") continue;
        throw error;
      }
      if (stat.isSymbolicLink())
        throw new Error(`Manifest source is a symbolic link: ${entry.path}`);
      if (entry.type === "file" && !stat.isFile())
        throw new Error(`Manifest file is not regular: ${entry.path}`);
      if (entry.type === "directory" && !stat.isDirectory())
        throw new Error(`Manifest directory is invalid: ${entry.path}`);
      await copyBuildContextNode(
        source,
        destination,
        entry.allowedExtensions ?? null,
      );
    }
    return destinationRoot;
  } catch (error) {
    await rm(destinationRoot, { recursive: true, force: true });
    throw error;
  }
}

export function redactSecrets(value, secrets = []) {
  let output = String(value ?? "");
  const candidates = [
    ...new Set(
      secrets.filter(
        (secret) => typeof secret === "string" && secret.length >= 8,
      ),
    ),
  ].sort((left, right) => right.length - left.length);
  for (const secret of candidates)
    output = output.replaceAll(secret, "[REDACTED]");
  output = output.replace(
    /postgres(?:ql)?:\/\/([^\s:/?#]+):([^\s@/?#]+)@/giu,
    "postgresql://$1:[REDACTED]@",
  );
  return output;
}

export function ambientSecretCandidates(env) {
  const candidates = [
    env.E2E_DATABASE_URL,
    env.E2E_READINESS_API_KEY,
    env.E2E_JWT_SECRET,
    env.E2E_OWNER_EMAIL,
    env.E2E_OWNER_PASSWORD,
    env.E2E_AUTH_COOKIE_DOMAIN,
  ];
  if (typeof env.E2E_DATABASE_URL === "string") {
    try {
      const parsed = new URL(env.E2E_DATABASE_URL);
      candidates.push(parsed.password, decodeURIComponent(parsed.password));
    } catch {
      // Configuration validation will report the malformed URL without echoing it.
    }
  }
  return [
    ...new Set(
      candidates.filter(
        (value) => typeof value === "string" && value.length > 0,
      ),
    ),
  ];
}

export async function assertLoopbackPortsAvailable(
  ports = LOCAL_PORTS,
  host = "127.0.0.1",
) {
  for (const { name, port } of ports) {
    await new Promise((resolvePromise, rejectPromise) => {
      const server = createServer();
      server.unref();
      server.once("error", (error) => {
        rejectPromise(
          new Error(
            `${name} loopback port ${host}:${port} is unavailable; the isolated E2E runner will not reuse or stop the process that owns it. (${error.code ?? error.message})`,
          ),
        );
      });
      server.listen({ host, port, exclusive: true }, () => {
        server.close((error) =>
          error ? rejectPromise(error) : resolvePromise(),
        );
      });
    });
  }
}

export function validateLocalDockerEndpoint(rawEndpoint) {
  if (
    typeof rawEndpoint !== "string" ||
    rawEndpoint.trim() !== rawEndpoint ||
    rawEndpoint === ""
  ) {
    throw new Error(
      "Docker context endpoint is missing or malformed; no build was started.",
    );
  }
  if (/^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9._-]+$/iu.test(rawEndpoint))
    return rawEndpoint;
  if (rawEndpoint.startsWith("unix://")) {
    if (/\\|%|\/\.{1,2}(?:\/|$)/iu.test(rawEndpoint)) {
      throw new Error(
        "Docker context endpoint is malformed; no build was started.",
      );
    }
    let parsed;
    try {
      parsed = new URL(rawEndpoint);
    } catch {
      throw new Error(
        "Docker context endpoint is malformed; no build was started.",
      );
    }
    if (
      parsed.protocol === "unix:" &&
      parsed.hostname === "" &&
      parsed.pathname.startsWith("/") &&
      !parsed.pathname.includes("..") &&
      !parsed.search &&
      !parsed.hash &&
      !parsed.username &&
      !parsed.password
    ) {
      return rawEndpoint;
    }
  }
  throw new Error(
    "Docker context must use a local unix socket or Windows named pipe; remote engines are forbidden.",
  );
}

export function assertNoDockerEndpointOverrides(env) {
  const overrides = FORBIDDEN_DOCKER_OVERRIDE_KEYS.filter(
    (name) => typeof env[name] === "string" && env[name].trim() !== "",
  );
  if (overrides.length > 0) {
    throw new Error(
      `Isolated E2E refuses Docker endpoint/context/TLS overrides (${overrides.join(", ")}); no build was started.`,
    );
  }
}

export function assertStandaloneComposeSource(source) {
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("Standalone isolated Compose source is missing.");
  }
  const hostFileDirectives =
    source.match(
      /^\s*(?:["']?(?:include|env_file|extends|label_file)["']?)\s*:/gmu,
    ) ?? [];
  if (hostFileDirectives.length > 0) {
    throw new Error(
      "Standalone isolated Compose must not load any secondary host file.",
    );
  }
}

export async function verifyLocalDockerContext(runCommand, env) {
  assertNoDockerEndpointOverrides(env);
  const result = await runCommand(
    "docker",
    ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
    { capture: true, env, timeoutMs: 30_000 },
  );
  let endpoint;
  try {
    endpoint = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(
      "Docker context inspection returned an invalid endpoint; no build was started.",
    );
  }
  validateLocalDockerEndpoint(endpoint);
  return endpoint;
}

export async function verifyIntegratedLocalBuilder(runCommand, env, endpoint) {
  const result = await runCommand(
    "docker",
    ["--host", endpoint, "buildx", "inspect", "default"],
    { capture: true, env, timeoutMs: 30_000 },
  );
  const driverLines = result.stdout.match(/^Driver:\s+(\S+)\s*$/gmu) ?? [];
  if (driverLines.length !== 1) {
    throw new Error(
      "Docker default builder inspection returned an invalid driver; no build was started.",
    );
  }
  const driver = driverLines[0].replace(/^Driver:\s+/u, "").trim();
  if (driver !== "docker") {
    throw new Error(
      "Docker default builder must use the local integrated docker driver; remote builders are forbidden.",
    );
  }
  return driver;
}

function parseDockerInspectRecords(stdout, label) {
  let records;
  try {
    records = JSON.parse(stdout);
  } catch {
    throw new Error(
      `${label} did not return valid JSON; runtime attestation failed closed.`,
    );
  }
  if (!Array.isArray(records)) {
    throw new Error(
      `${label} did not return an inspect array; runtime attestation failed closed.`,
    );
  }
  return records;
}

export async function captureBuiltImageAttestation(
  runCommand,
  endpoint,
  identity,
  env,
) {
  const result = await runCommand(
    "docker",
    [
      "--host",
      endpoint,
      "image",
      "inspect",
      identity.appImage,
      identity.databaseImage,
      identity.gatewayImage,
    ],
    { capture: true, env, timeoutMs: 60_000 },
  );
  return attestBuiltImages(
    parseDockerInspectRecords(result.stdout, "Docker image inspect"),
    identity.projectName,
  );
}

export async function captureRunningContainerAttestation(
  runCommand,
  endpoint,
  identity,
  env,
  builtAttestation,
) {
  const listed = await runCommand(
    "docker",
    [
      "--host",
      endpoint,
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${identity.projectName}`,
    ],
    { capture: true, env, timeoutMs: 60_000 },
  );
  const containerIds = listed.stdout
    .split(/\r?\n/u)
    .filter((value) => value !== "");
  if (
    containerIds.length !== 4 ||
    new Set(containerIds).size !== 4 ||
    containerIds.some((value) => !/^[0-9a-f]{12,64}$/u.test(value))
  ) {
    throw new Error(
      "Docker did not report exactly four runner-owned service containers; runtime attestation failed closed.",
    );
  }
  const inspected = await runCommand(
    "docker",
    ["--host", endpoint, "container", "inspect", ...containerIds],
    { capture: true, env, timeoutMs: 60_000 },
  );
  return attestRunningContainers(
    parseDockerInspectRecords(inspected.stdout, "Docker container inspect"),
    builtAttestation,
  );
}

function portBinding(service, target) {
  return (service.ports ?? []).find((port) => Number(port.target) === target);
}

function assertExactLoopbackPort(serviceName, service, target, published) {
  if (!Array.isArray(service.ports) || service.ports.length !== 1) {
    throw new Error(`${serviceName} must have exactly one published port.`);
  }
  const binding = portBinding(service, target);
  if (binding) {
    assertExactObjectKeys(`${serviceName} published port`, binding, [
      "host_ip",
      "mode",
      "protocol",
      "published",
      "target",
    ]);
  }
  if (
    !binding ||
    Number(binding.published) !== published ||
    binding.host_ip !== "127.0.0.1" ||
    binding.protocol !== "tcp" ||
    binding.mode !== "ingress"
  ) {
    throw new Error(
      `${serviceName} must publish container port ${target} only over TCP on 127.0.0.1:${published}.`,
    );
  }
}

function assertNoPublishedPorts(serviceName, service) {
  if (hasConfiguredEntries(service.ports)) {
    throw new Error(
      `${serviceName} must not publish any host port; only gateway may publish loopback ports.`,
    );
  }
}

function assertExactGatewayPorts(service) {
  const expected = new Map([
    [3302, 3302],
    [3303, 3303],
    [55434, 55434],
  ]);
  if (!Array.isArray(service.ports) || service.ports.length !== expected.size) {
    throw new Error(
      "gateway must publish exactly the three audited loopback TCP ports.",
    );
  }
  for (const [target, published] of expected) {
    const binding = portBinding(service, target);
    if (binding) {
      assertExactObjectKeys("gateway published port", binding, [
        "host_ip",
        "mode",
        "protocol",
        "published",
        "target",
      ]);
    }
    if (
      !binding ||
      Number(binding.published) !== published ||
      binding.host_ip !== "127.0.0.1" ||
      binding.protocol !== "tcp" ||
      binding.mode !== "ingress"
    ) {
      throw new Error(
        "gateway may publish only the exact audited TCP routes on 127.0.0.1.",
      );
    }
  }
}

function tmpfsTargets(service) {
  const entries = service.tmpfs ?? [];
  return entries.map((entry) => String(entry).split(":", 1)[0]);
}

function hasConfiguredEntries(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value) || typeof value === "string")
    return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function expectedLocalServiceEnvironments(identity) {
  const composeEnv = identity?.composeEnv;
  if (!composeEnv) {
    throw new Error(
      "Runner-generated Compose environment is required for exact service validation.",
    );
  }
  return {
    db: {
      E2E_DATABASE_INSTANCE_ID: composeEnv.E2E_DATABASE_INSTANCE_ID,
      E2E_DATABASE_RUNNER_PASSWORD: composeEnv.E2E_DATABASE_RUNNER_PASSWORD,
      POSTGRES_DB: "postgres",
      POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256 --auth-local=trust",
      POSTGRES_PASSWORD: composeEnv.E2E_BOOTSTRAP_PASSWORD,
      POSTGRES_USER: "charitypilot_e2e_bootstrap",
    },
    api: {
      API_URL: LOCAL_CONTRACT.apiUrl,
      DATABASE_URL:
        `postgresql://${LOCAL_CONTRACT.databaseUser}:${composeEnv.E2E_DATABASE_RUNNER_PASSWORD}` +
        `@db:${LOCAL_CONTRACT.databaseServerPort}/${LOCAL_CONTRACT.databaseName}` +
        `?schema=${LOCAL_CONTRACT.databaseSchema}&application_name=charitypilot-api-e2e`,
      DOCUMENT_STORAGE_DRIVER: "local",
      E2E_DATABASE_IDENTITY_PROBE_ENABLED: "true",
      E2E_DATABASE_INSTANCE_ID: composeEnv.E2E_DATABASE_INSTANCE_ID,
      FRONTEND_URL: LOCAL_CONTRACT.webUrl,
      HOST: "0.0.0.0",
      JWT_EXPIRY: "15m",
      JWT_SECRET: composeEnv.E2E_JWT_SECRET,
      LOCAL_FILE_STORAGE_DIR: "/var/lib/charitypilot-e2e-documents",
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "development",
      PORT: "3302",
      READINESS_API_KEY: composeEnv.E2E_READINESS_API_KEY,
      REFRESH_TOKEN_TTL_DAYS: "7",
      SEED_LOCAL_ADMIN: "false",
      TRUSTED_PROXY_ADDRESSES: "",
    },
    web: {
      CHARITYPILOT_INTERNAL_API_URL: "http://api:3302",
      HOST: "0.0.0.0",
      NEXT_PUBLIC_API_URL: LOCAL_CONTRACT.apiUrl,
      NEXT_PUBLIC_CHARITYPILOT_E2E_MODE: LOCAL_CONTRACT.executionMode,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
      PORT: "3303",
    },
  };
}

function assertExactServiceEnvironment(serviceName, actual, expected) {
  const actualRecord =
    actual && typeof actual === "object" && !Array.isArray(actual)
      ? actual
      : {};
  const actualKeys = Object.keys(actualRecord).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${serviceName} must receive only the runner-owned environment contract.`,
    );
  }
  for (const key of expectedKeys) {
    if (actualRecord[key] !== expected[key]) {
      throw new Error(
        `${serviceName} environment does not match the runner-owned contract.`,
      );
    }
  }
}

function assertExactObjectKeys(label, value, expectedKeys) {
  const actualKeys =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).sort()
      : [];
  const sortedExpected = [...expectedKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${label} contains an unexpected or missing field.`);
  }
}

function assertHealthyDependency(serviceName, dependencies, dependencyName) {
  const dependency = dependencies?.[dependencyName];
  assertExactObjectKeys(
    `${serviceName} ${dependencyName} dependency`,
    dependency,
    ["condition", "required"],
  );
  if (
    dependency.condition !== "service_healthy" ||
    dependency.required !== true
  ) {
    throw new Error(
      `${serviceName} must wait for the exact healthy ${dependencyName} dependency.`,
    );
  }
}

const EXPECTED_SERVICE_KEYS = Object.freeze({
  api: Object.freeze([
    "build",
    "cap_drop",
    "command",
    "depends_on",
    "entrypoint",
    "environment",
    "healthcheck",
    "image",
    "init",
    "networks",
    "read_only",
    "security_opt",
    "tmpfs",
    "user",
  ]),
  db: Object.freeze([
    "build",
    "command",
    "entrypoint",
    "environment",
    "healthcheck",
    "image",
    "networks",
    "read_only",
    "stop_grace_period",
    "tmpfs",
  ]),
  gateway: Object.freeze([
    "build",
    "cap_drop",
    "command",
    "depends_on",
    "entrypoint",
    "healthcheck",
    "image",
    "init",
    "networks",
    "ports",
    "read_only",
    "security_opt",
    "stop_grace_period",
    "user",
  ]),
  web: Object.freeze([
    "cap_drop",
    "command",
    "depends_on",
    "entrypoint",
    "environment",
    "healthcheck",
    "image",
    "init",
    "networks",
    "read_only",
    "security_opt",
    "tmpfs",
    "user",
  ]),
});

const EXPECTED_SERVICE_COMMANDS = Object.freeze({
  api: Object.freeze([
    "sh",
    "-lc",
    "set -eu\n" +
      "./node_modules/.bin/prisma migrate deploy --schema apps/api/prisma/schema.prisma\n" +
      "./node_modules/.bin/tsx apps/api/prisma/seed.ts\n" +
      "exec node --import tsx apps/api/src/server.ts\n",
  ]),
  db: null,
  gateway: Object.freeze(["/gateway/tcp-gateway.mjs"]),
  web: Object.freeze(["node", "apps/web/server.mjs"]),
});

const EXPECTED_SERVICE_ENTRYPOINTS = Object.freeze({
  api: null,
  db: null,
  gateway: Object.freeze(["node"]),
  web: null,
});

const EXPECTED_E2E_NETWORK_ALIASES = Object.freeze({
  api: Object.freeze(["api.charitypilot-e2e.invalid"]),
  db: Object.freeze(["db.charitypilot-e2e.invalid"]),
  web: Object.freeze(["web.charitypilot-e2e.invalid"]),
});

const EXPECTED_HEALTHCHECKS = Object.freeze({
  api: Object.freeze({
    test: Object.freeze([
      "CMD-SHELL",
      "node -e \"fetch('http://127.0.0.1:3302/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\"",
    ]),
    interval: "3s",
    timeout: "5s",
    retries: 80,
    start_period: "20s",
  }),
  db: Object.freeze({
    test: Object.freeze([
      "CMD-SHELL",
      "PGPASSWORD=$$E2E_DATABASE_RUNNER_PASSWORD pg_isready -U charitypilot_e2e_runner -d charitypilot_e2e_disposable",
    ]),
    interval: "2s",
    timeout: "3s",
    retries: 45,
    start_period: "5s",
  }),
  gateway: Object.freeze({
    test: Object.freeze([
      "CMD",
      "node",
      "-e",
      "const fs=require('node:fs');const listeners=new Set(fs.readFileSync('/proc/net/tcp','utf8').trim().split('\\n').slice(1).filter(line=>line.trim().split(/\\s+/)[3]==='0A').map(line=>line.trim().split(/\\s+/)[1]));process.exit(['00000000:D88A','00000000:0CE6','00000000:0CE7'].every(listener=>listeners.has(listener))?0:1)",
    ]),
    interval: "3s",
    timeout: "3s",
    retries: 10,
    start_period: "2s",
  }),
  web: Object.freeze({
    test: Object.freeze([
      "CMD-SHELL",
      "node -e \"fetch('http://127.0.0.1:3303/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\"",
    ]),
    interval: "3s",
    timeout: "5s",
    retries: 80,
    start_period: "30s",
  }),
});

const EXPECTED_TMPFS = Object.freeze({
  api: Object.freeze([
    "/var/lib/charitypilot-e2e-documents:rw,nosuid,nodev,noexec,size=256m,mode=0700,uid=1000,gid=1000",
    "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
  ]),
  db: Object.freeze([
    "/var/lib/postgresql/data:rw,nosuid,nodev,size=1024m,mode=0700",
    "/var/run/postgresql:rw,nosuid,nodev,noexec,size=16m,mode=0775",
    "/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777",
  ]),
  gateway: Object.freeze([]),
  web: Object.freeze(["/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777"]),
});

function assertExactHealthcheck(serviceName, actual) {
  const expected = EXPECTED_HEALTHCHECKS[serviceName];
  assertExactObjectKeys(
    `${serviceName} healthcheck`,
    actual,
    Object.keys(expected),
  );
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(expectedValue)) {
      throw new Error(
        `${serviceName} must use only its exact bounded healthcheck.`,
      );
    }
  }
}

export function validateRenderedCompose(
  model,
  projectName,
  repoRoot = ROOT,
  expectedBuildContext = join(
    repoRoot,
    `.codex-e2e-context-${projectName.replace(/^charitypilot-e2e-/u, "")}`,
  ),
  identity,
) {
  if (!model || typeof model !== "object" || !model.services) {
    throw new Error("docker compose config did not return a service model.");
  }
  if (model.name !== projectName) {
    throw new Error(
      "Rendered Compose project name does not match the runner-owned cleanup identity.",
    );
  }
  const resolvedContext = resolve(expectedBuildContext);
  if (
    dirname(resolvedContext) !== resolve(repoRoot) ||
    !resolvedContext.startsWith(
      `${resolve(repoRoot)}${process.platform === "win32" ? "\\" : "/"}.codex-e2e-context-`,
    )
  ) {
    throw new Error(
      "Runner build context must be an exact generated directory under the repository root.",
    );
  }
  const serviceNames = Object.keys(model.services).sort();
  const expectedServices = ["api", "db", "gateway", "web"];
  if (JSON.stringify(serviceNames) !== JSON.stringify(expectedServices)) {
    throw new Error(
      `Isolated compose must contain only ${expectedServices.join(", ")}.`,
    );
  }

  for (const [serviceName, service] of Object.entries(model.services)) {
    if (service.container_name !== undefined || service.restart !== undefined) {
      throw new Error(`${serviceName} must not set container_name or restart.`);
    }
    if (
      service.privileged === true ||
      service.network_mode !== undefined ||
      service.pid !== undefined ||
      service.ipc !== undefined ||
      service.pull_policy !== undefined ||
      (service.cap_add?.length ?? 0) > 0 ||
      hasConfiguredEntries(service.devices) ||
      hasConfiguredEntries(service.extra_hosts) ||
      hasConfiguredEntries(service.volumes_from) ||
      hasConfiguredEntries(service.external_links)
    ) {
      throw new Error(
        `${serviceName} requests a privileged or host-coupled container setting.`,
      );
    }
    const attachedNetworks = Object.keys(service.networks ?? {}).sort();
    const expectedNetworks =
      serviceName === "gateway" ? ["e2e", "edge"] : ["e2e"];
    if (JSON.stringify(attachedNetworks) !== JSON.stringify(expectedNetworks)) {
      throw new Error(
        serviceName === "gateway"
          ? "gateway must attach only to the isolated e2e and project edge bridges without aliases or static addressing."
          : `${serviceName} must attach only to the isolated e2e bridge network.`,
      );
    }
    if (serviceName === "gateway") {
      if (
        expectedNetworks.some(
          (networkName) => service.networks[networkName] !== null,
        )
      ) {
        throw new Error(
          "gateway must attach only to the isolated e2e and project edge bridges without aliases or static addressing.",
        );
      }
    } else {
      const attachment = service.networks.e2e;
      assertExactObjectKeys(
        `${serviceName} e2e network attachment`,
        attachment,
        ["aliases"],
      );
      if (
        JSON.stringify(attachment.aliases) !==
        JSON.stringify(EXPECTED_E2E_NETWORK_ALIASES[serviceName])
      ) {
        throw new Error(
          `${serviceName} must use only its exact reserved isolated e2e network alias.`,
        );
      }
    }
    if (serviceName !== "gateway") assertNoPublishedPorts(serviceName, service);

    if (
      JSON.stringify(service.entrypoint) !==
        JSON.stringify(EXPECTED_SERVICE_ENTRYPOINTS[serviceName]) ||
      JSON.stringify(service.command) !==
        JSON.stringify(EXPECTED_SERVICE_COMMANDS[serviceName])
    ) {
      throw new Error(
        `${serviceName} must use only the audited isolated startup command.`,
      );
    }
    assertExactHealthcheck(serviceName, service.healthcheck);
    if (
      JSON.stringify(service.tmpfs ?? []) !==
      JSON.stringify(EXPECTED_TMPFS[serviceName])
    ) {
      throw new Error(
        `${serviceName} must use only its exact isolated tmpfs contract.`,
      );
    }
    if (
      (serviceName === "db" && service.stop_grace_period !== "15s") ||
      (serviceName === "gateway" && service.stop_grace_period !== "10s")
    ) {
      throw new Error(
        `${serviceName} must use its exact bounded stop grace period.`,
      );
    }
    if (serviceName === "api") {
      assertExactObjectKeys("api dependencies", service.depends_on, ["db"]);
      assertHealthyDependency("api", service.depends_on, "db");
    } else if (serviceName === "gateway") {
      assertExactObjectKeys("gateway dependencies", service.depends_on, [
        "api",
        "db",
        "web",
      ]);
      for (const dependencyName of ["api", "db", "web"]) {
        assertHealthyDependency("gateway", service.depends_on, dependencyName);
      }
    } else if (serviceName === "web") {
      assertExactObjectKeys("web dependencies", service.depends_on, ["api"]);
      assertHealthyDependency("web", service.depends_on, "api");
    }

    if ((service.volumes ?? []).length !== 0) {
      throw new Error(
        `${serviceName} must not mount any host path or persistent volume.`,
      );
    }
    if (service.read_only !== true) {
      throw new Error(`${serviceName} must use a read-only root filesystem.`);
    }

    const build = service.build;
    if (serviceName === "web") {
      if (build !== undefined) {
        throw new Error(
          "web must reuse the exact prebuilt runner app image and must not export that tag again.",
        );
      }
    } else {
      const dockerfilePath = build?.dockerfile
        ? resolve(build.context, build.dockerfile)
        : null;
      const unexpectedBuildKeys =
        build && typeof build === "object"
          ? Object.keys(build).filter(
              (key) => !["context", "dockerfile", "target"].includes(key),
            )
          : [];
      if (
        !build ||
        resolve(build.context) !== resolvedContext ||
        dockerfilePath !==
          resolve(resolvedContext, "e2e", "docker", "Dockerfile") ||
        unexpectedBuildKeys.length > 0
      ) {
        throw new Error(
          `${serviceName} must build only from the sanitized repository context.`,
        );
      }
    }
    if (
      hasConfiguredEntries(service.configs) ||
      hasConfiguredEntries(service.secrets)
    ) {
      throw new Error(
        `${serviceName} must not receive Compose configs or secrets.`,
      );
    }
    assertExactObjectKeys(
      `${serviceName} service`,
      service,
      EXPECTED_SERVICE_KEYS[serviceName],
    );
  }

  const expectedAppImage = `${projectName}-app:local`;
  const expectedDatabaseImage = `${projectName}-database:local`;
  const expectedGatewayImage = `${projectName}-gateway:local`;
  if (
    model.services.api.image !== expectedAppImage ||
    model.services.web.image !== expectedAppImage ||
    model.services.db.image !== expectedDatabaseImage ||
    model.services.gateway.image !== expectedGatewayImage ||
    model.services.api.build.target !== "app" ||
    model.services.web.build !== undefined ||
    model.services.db.build.target !== "database" ||
    model.services.gateway.build.target !== "gateway"
  ) {
    throw new Error(
      "Rendered services must use only the runner-scoped app/database/gateway images and audited build targets.",
    );
  }
  for (const serviceName of ["api", "gateway", "web"]) {
    const service = model.services[serviceName];
    if (
      service.user !== "1000:1000" ||
      service.init !== true ||
      JSON.stringify(service.cap_drop ?? []) !== JSON.stringify(["ALL"]) ||
      JSON.stringify(service.security_opt ?? []) !==
        JSON.stringify(["no-new-privileges:true"])
    ) {
      throw new Error(
        `${serviceName} must run as the locked-down non-root app user.`,
      );
    }
  }

  const expectedEnvironments = expectedLocalServiceEnvironments(identity);
  for (const serviceName of Object.keys(expectedEnvironments)) {
    assertExactServiceEnvironment(
      serviceName,
      model.services[serviceName].environment,
      expectedEnvironments[serviceName],
    );
  }
  if (model.services.gateway.environment !== undefined) {
    throw new Error("gateway must not receive any runtime environment value.");
  }

  assertNoPublishedPorts("db", model.services.db);
  assertNoPublishedPorts("api", model.services.api);
  assertNoPublishedPorts("web", model.services.web);
  assertExactGatewayPorts(model.services.gateway);

  if (!tmpfsTargets(model.services.db).includes("/var/lib/postgresql/data")) {
    throw new Error(
      "The isolated database must store its data directory in tmpfs.",
    );
  }
  if (
    !tmpfsTargets(model.services.api).includes(
      "/var/lib/charitypilot-e2e-documents",
    )
  ) {
    throw new Error(
      "The isolated API must store local document bytes in tmpfs.",
    );
  }
  if (String(model.services.api.environment?.SEED_LOCAL_ADMIN) !== "false") {
    throw new Error("The isolated API must keep SEED_LOCAL_ADMIN=false.");
  }
  if (
    model.services.api.environment?.DATABASE_URL?.includes("charitypilot_dev")
  ) {
    throw new Error(
      "The isolated API must never reference the personal development database.",
    );
  }

  if (tmpfsTargets(model.services.web).includes("/app/apps/web/.next")) {
    throw new Error(
      "The isolated web service must run its immutable baked .next build from the image.",
    );
  }
  if (Object.keys(model.volumes ?? {}).length !== 0) {
    throw new Error("The isolated stack must not declare persistent volumes.");
  }
  if (
    hasConfiguredEntries(model.configs) ||
    hasConfiguredEntries(model.secrets)
  ) {
    throw new Error(
      "The isolated stack must not declare top-level configs or secrets.",
    );
  }

  const declaredNetworks = Object.entries(model.networks ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  if (
    declaredNetworks.length !== 2 ||
    declaredNetworks[0][0] !== "e2e" ||
    declaredNetworks[1][0] !== "edge"
  ) {
    throw new Error(
      "The isolated stack must declare exactly the e2e and edge networks.",
    );
  }
  const network = model.networks.e2e;
  if (
    network.external === true ||
    network.driver !== "bridge" ||
    network.internal !== true ||
    network.attachable === true ||
    network.name !== `${projectName}_e2e` ||
    hasConfiguredEntries(network.ipam)
  ) {
    throw new Error(
      "The isolated e2e network must be a non-external project-scoped bridge.",
    );
  }
  assertExactObjectKeys("e2e network", network, [
    "driver",
    "internal",
    "ipam",
    "name",
  ]);
  const edgeNetwork = model.networks.edge;
  if (
    edgeNetwork.external === true ||
    edgeNetwork.driver !== "bridge" ||
    edgeNetwork.internal !== undefined ||
    edgeNetwork.attachable === true ||
    edgeNetwork.name !== `${projectName}_edge` ||
    hasConfiguredEntries(edgeNetwork.ipam)
  ) {
    throw new Error(
      "The isolated edge network must be a non-external, non-attachable project-scoped bridge.",
    );
  }
  assertExactObjectKeys("edge network", edgeNetwork, [
    "driver",
    "ipam",
    "name",
  ]);
  return true;
}

export function npmInvocation(args, env = process.env) {
  if (process.platform !== "win32") return { command: "npm", args };
  const npmCli =
    env.npm_execpath ??
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return { command: process.execPath, args: [npmCli, ...args] };
}

const checkedWindowsTreeTerminationProofs = new WeakSet();
const closedChildLeaders = new WeakSet();

export function checkedWindowsTaskkill(child, options = {}) {
  if (!child?.pid) {
    throw new Error("Checked Windows tree termination requires a child PID.");
  }
  const spawnSyncFn = options.spawnSyncFn ?? spawnSync;
  const timeoutMs = options.timeoutMs ?? WINDOWS_TASKKILL_TIMEOUT_MS;
  const result = spawnSyncFn(
    "taskkill",
    ["/PID", String(child.pid), "/T", "/F"],
    {
      stdio: "ignore",
      windowsHide: true,
      timeout: timeoutMs,
    },
  );
  if (result?.error || result?.signal || result?.status !== 0) {
    throw new Error(
      "Checked Windows taskkill did not positively terminate the exact child tree.",
    );
  }
  checkedWindowsTreeTerminationProofs.add(child);
}

export function isExactPosixChildGroupAbsent(child, options = {}) {
  if (!child?.pid) return true;
  const processKillFn = options.processKillFn ?? process.kill.bind(process);
  try {
    processKillFn(-child.pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw new Error(
      "The exact POSIX child process group could not be probed safely.",
    );
  }
}

export function terminateChildTree(child, signal = "SIGTERM", options = {}) {
  if (!child?.pid) return;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    checkedWindowsTaskkill(child, options);
    return;
  }
  const processKillFn = options.processKillFn ?? process.kill.bind(process);
  try {
    processKillFn(-child.pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw new Error(
      "The exact POSIX child process group could not be signalled safely.",
    );
  }
}

function createChildCloseWaiter(child) {
  if (closedChildLeaders.has(child)) {
    return { wait: async () => {}, cancel: () => {} };
  }
  let observed = false;
  let cancel;
  let resolveObserved;
  const observedPromise = new Promise((resolvePromise) => {
    resolveObserved = resolvePromise;
  });
  const onClose = () => {
    observed = true;
    closedChildLeaders.add(child);
    resolveObserved();
  };
  child.once?.("close", onClose);
  cancel = () => {
    child.removeListener?.("close", onClose);
    resolveObserved();
  };
  return {
    async wait(timeoutMs) {
      if (observed) return;
      let timer;
      try {
        await Promise.race([
          observedPromise,
          new Promise((_, rejectPromise) => {
            timer = setTimeout(() => {
              rejectPromise(
                new Error(
                  "The exact E2E child tree did not close within its bounded shutdown window.",
                ),
              );
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!observed) {
        throw new Error(
          "The exact E2E child close waiter was canceled without close proof.",
        );
      }
    },
    cancel,
  };
}

async function waitForExactPosixChildGroupAbsence(
  child,
  timeoutMs,
  probeFn,
  sleepFn,
) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await probeFn(child)) return true;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleepFn(Math.min(EXACT_CHILD_PROBE_INTERVAL_MS, remainingMs));
  } while (Date.now() <= deadline);
  return probeFn(child);
}

export async function stopAndWaitForExactChildTree(child, options = {}) {
  if (!child?.pid) return;
  const termGraceMs = options.termGraceMs ?? EXACT_CHILD_TERM_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? EXACT_CHILD_KILL_GRACE_MS;
  const terminateFn = options.terminateFn ?? terminateChildTree;
  const platform = options.platform ?? process.platform;
  const probeFn =
    options.probeFn ??
    ((candidate) =>
      isExactPosixChildGroupAbsent(candidate, {
        processKillFn: options.processKillFn,
      }));
  const sleepFn =
    options.sleepFn ??
    ((delayMs) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)));
  if (
    !Number.isSafeInteger(termGraceMs) ||
    termGraceMs < 1 ||
    !Number.isSafeInteger(killGraceMs) ||
    killGraceMs < 1
  ) {
    throw new Error(
      "Exact child-tree shutdown windows must be positive integers.",
    );
  }
  if (typeof terminateFn !== "function") {
    throw new Error("Exact child-tree termination must be callable.");
  }
  if (typeof probeFn !== "function" || typeof sleepFn !== "function") {
    throw new Error("Exact child-tree absence proof must be callable.");
  }

  const closeWaiter = createChildCloseWaiter(child);

  if (platform === "win32") {
    try {
      await terminateFn(child, "SIGTERM");
      await closeWaiter.wait(termGraceMs + killGraceMs);
    } catch (error) {
      closeWaiter.cancel();
      throw new Error(
        `The exact Windows E2E child tree lacks checked taskkill-and-close proof: ${error?.message ?? "termination failed"}`,
      );
    }
    if (!checkedWindowsTreeTerminationProofs.has(child)) {
      throw new Error(
        "The exact Windows E2E child tree lacks checked taskkill authority.",
      );
    }
    return;
  }

  try {
    let groupAbsent = await probeFn(child);
    if (!groupAbsent) {
      await terminateFn(child, "SIGTERM");
      groupAbsent = await waitForExactPosixChildGroupAbsence(
        child,
        termGraceMs,
        probeFn,
        sleepFn,
      );
    }
    if (!groupAbsent) {
      await terminateFn(child, "SIGKILL");
      groupAbsent = await waitForExactPosixChildGroupAbsence(
        child,
        killGraceMs,
        probeFn,
        sleepFn,
      );
    }
    if (!groupAbsent) {
      throw new Error(
        "The exact POSIX E2E child process group survived bounded SIGTERM/SIGKILL shutdown.",
      );
    }
    await closeWaiter.wait(killGraceMs);
  } catch (error) {
    closeWaiter.cancel();
    if (
      error?.message ===
      "The exact POSIX E2E child process group survived bounded SIGTERM/SIGKILL shutdown."
    ) {
      throw error;
    }
    throw new Error(
      `The exact POSIX E2E child group lacks bounded absence-and-close proof: ${error?.message ?? "termination proof failed"}`,
    );
  }
}

function lineRedactingWriter(target, secrets) {
  let pending = "";
  return {
    write(chunk) {
      pending += chunk.toString();
      const lines = pending.split(/(?<=\n)/u);
      pending = lines.pop() ?? "";
      for (const line of lines) target.write(redactSecrets(line, secrets));
      if (pending.length > 1024 * 1024) {
        target.write(redactSecrets(pending, secrets));
        pending = "";
      }
    },
    end() {
      if (pending) target.write(redactSecrets(pending, secrets));
      pending = "";
    },
  };
}

export function createCommandRunner({
  cwd = ROOT,
  secrets = [],
  onChild,
  spawnFn = spawn,
  shutdownChild,
  defaultSignal,
} = {}) {
  return function runCommand(command, args, options = {}) {
    const cancellationSignal =
      options.signal === null ? undefined : (options.signal ?? defaultSignal);
    cancellationSignal?.throwIfAborted();
    return new Promise((resolvePromise, rejectPromise) => {
      const capture = options.capture === true;
      const stdoutChunks = [];
      const stderrChunks = [];
      const stdoutWriter = capture
        ? null
        : lineRedactingWriter(process.stdout, secrets);
      const stderrWriter = capture
        ? null
        : lineRedactingWriter(process.stderr, secrets);
      let child;
      try {
        // This is the final synchronous authority check before process creation.
        // A deadline/signal that fired after an upstream preflight can never
        // cross this boundary and create an untracked Playwright process.
        cancellationSignal?.throwIfAborted();
        child = spawnFn(command, args, {
          cwd: options.cwd ?? cwd,
          env: options.env ?? process.env,
          stdio: ["inherit", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        });
      } catch (error) {
        rejectPromise(error);
        return;
      }
      onChild?.(child);
      let timedOut = false;
      let abortRequested = false;
      let childClosed = false;
      let settled = false;
      let shutdownPromise = null;
      let closeResult = null;
      const exactShutdown =
        shutdownChild ??
        ((candidate) =>
          stopAndWaitForExactChildTree(
            candidate,
            options.childShutdownOptions,
          ));

      const removeAbortListener = () => {
        cancellationSignal?.removeEventListener("abort", onAbort);
      };
      const settleRejected = (error) => {
        if (settled) return;
        settled = true;
        removeAbortListener();
        rejectPromise(error);
      };
      const settleResolved = (result) => {
        if (settled) return;
        settled = true;
        removeAbortListener();
        resolvePromise(result);
      };
      const interruptedError = () => {
        if (cancellationSignal?.reason instanceof Error) {
          return cancellationSignal.reason;
        }
        return new Error(`${command} was interrupted before completion.`);
      };
      const settleInterruptedCommand = async () => {
        if (!shutdownPromise) return;
        try {
          await shutdownPromise;
        } catch (error) {
          const failure = new Error(
            `Exact child-tree shutdown failed closed; manual process and remote-database recovery is required. ${error?.message ?? "Termination proof failed."}`,
          );
          failure.exactTreeTerminationUnproven = true;
          settleRejected(failure);
          return;
        }
        // Checked Windows termination requires taskkill success plus leader
        // close. POSIX also waits for close here after proving group ESRCH, so
        // a leader-close event can never beat the descendant-absence proof.
        if (!childClosed) return;
        onChild?.(null, child);
        if (abortRequested) {
          settleRejected(interruptedError());
          return;
        }
        if (timedOut) {
          const error = new Error(
            `${command} exceeded its bounded execution time.`,
          );
          error.exitCode = 124;
          error.result = closeResult;
          settleRejected(error);
        }
      };
      const beginExactShutdown = (reason) => {
        if (reason === "abort") abortRequested = true;
        if (reason === "timeout") timedOut = true;
        if (!shutdownPromise) {
          shutdownPromise = Promise.resolve().then(() => exactShutdown(child));
          void shutdownPromise.then(
            () => settleInterruptedCommand(),
            () => settleInterruptedCommand(),
          );
        }
        return shutdownPromise;
      };
      const onAbort = () => {
        // Never throw from an AbortSignal event. The checked shutdown promise
        // owns termination, proof, and command settlement.
        void beginExactShutdown("abort");
      };
      const commandTimeout =
        Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
          ? setTimeout(() => {
              // Never throw from a timer callback.
              void beginExactShutdown("timeout");
            }, options.timeoutMs)
          : null;
      commandTimeout?.unref();

      cancellationSignal?.addEventListener("abort", onAbort, { once: true });
      if (cancellationSignal?.aborted) onAbort();

      child.stdout?.on("data", (chunk) => {
        if (capture) stdoutChunks.push(chunk);
        stdoutWriter?.write(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        if (capture) stderrChunks.push(chunk);
        stderrWriter?.write(chunk);
      });
      child.once?.("error", (error) => {
        if (!child?.pid) {
          if (commandTimeout) clearTimeout(commandTimeout);
          onChild?.(null, child);
          stdoutWriter?.end();
          stderrWriter?.end();
          settleRejected(error);
        }
      });
      child.once?.("close", async (code, signal) => {
        if (commandTimeout) clearTimeout(commandTimeout);
        childClosed = true;
        closedChildLeaders.add(child);
        stdoutWriter?.end();
        stderrWriter?.end();
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const result = { code: code ?? 1, signal, stdout, stderr, timedOut };
        closeResult = result;
        if (shutdownPromise) {
          await settleInterruptedCommand();
          return;
        }
        if (cancellationSignal?.aborted) {
          await beginExactShutdown("abort");
          await settleInterruptedCommand();
          return;
        }
        if (
          options.requireExactTreeAbsenceOnClose ??
          process.platform !== "win32"
        ) {
          // A POSIX group leader can close while detached descendants retain
          // the runner-owned PGID. Prove ESRCH (terminating survivors if
          // necessary) before clearing that identity or settling any ordinary
          // success/failure result.
          void beginExactShutdown("completion");
          await settleInterruptedCommand();
          if (settled) return;
        }
        onChild?.(null, child);
        if (result.code !== 0 && !options.allowFailure) {
          const detail = redactSecrets(
            stderr || stdout || `${command} exited ${result.code}`,
            secrets,
          ).trim();
          const error = new Error(detail || `${command} exited ${result.code}`);
          error.exitCode = result.code;
          error.result = result;
          settleRejected(error);
          return;
        }
        settleResolved(result);
      });
    });
  };
}

export function composeInvocation(projectName, envFile, composeFile, ...args) {
  if (typeof composeFile !== "string" || composeFile.length === 0) {
    throw new Error("A runner-owned Compose snapshot is required.");
  }
  return [
    "compose",
    "--project-directory",
    ROOT,
    "--project-name",
    projectName,
    "--env-file",
    envFile,
    "--file",
    composeFile,
    ...args,
  ];
}

export function daemonComposeInvocation(
  endpoint,
  projectName,
  envFile,
  composeFile,
  ...args
) {
  return [
    "--host",
    endpoint,
    ...composeInvocation(projectName, envFile, composeFile, ...args),
  ];
}

export async function waitForEndpoint(url, label, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollMs = options.pollMs ?? 1_500;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const fetchFn = options.fetchFn ?? fetch;
  const cancellationSignal = options.signal;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    cancellationSignal?.throwIfAborted();
    try {
      const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
      const response = await fetchFn(url, {
        redirect: "manual",
        signal: cancellationSignal
          ? AbortSignal.any([cancellationSignal, timeoutSignal])
          : timeoutSignal,
      });
      if (response.status < 500) return;
    } catch (error) {
      if (cancellationSignal?.aborted) throw cancellationSignal.reason ?? error;
      // The service is still starting.
    }
    await new Promise((resolvePromise, rejectPromise) => {
      const onAbort = () => {
        clearTimeout(timer);
        rejectPromise(
          cancellationSignal.reason ?? new Error("E2E wait aborted."),
        );
      };
      const timer = setTimeout(() => {
        cancellationSignal?.removeEventListener("abort", onAbort);
        resolvePromise();
      }, pollMs);
      if (cancellationSignal)
        cancellationSignal.addEventListener("abort", onAbort, { once: true });
    });
  }
  throw new Error(
    `${label} did not become ready at ${url} within ${Math.ceil(timeoutMs / 1000)} seconds.`,
  );
}

function assertNoAmbientLocalAuthority(env) {
  const injected = FORBIDDEN_AMBIENT_LOCAL_KEYS.filter(
    (key) => env[key] !== undefined,
  );
  if (injected.length > 0) {
    throw new Error(
      `Local isolated E2E does not accept ambient reset authority (${injected.join(", ")}); the runner generates a fresh identity.`,
    );
  }
  if (env.E2E_EXECUTION_MODE && env.E2E_EXECUTION_MODE !== "local-disposable") {
    throw new Error(
      "Local isolated E2E refuses an ambient non-local execution mode.",
    );
  }
}

function deployedQaEnvironment(env) {
  const forbidden = [
    "E2E_EXECUTION_MODE",
    "E2E_DATABASE_URL",
    "E2E_DATABASE_INSTANCE_ID",
    "E2E_DESTRUCTIVE_RESET_CONFIRMATION",
    "E2E_REMOTE_DATABASE_RESET_OVERRIDE",
    "E2E_REMOTE_DATABASE_HOST",
    "E2E_DATABASE_SERVER_ADDRESS",
    "E2E_DATABASE_EXPECTED_COMMENT",
    "E2E_DATABASE_EXPECTED_SCHEMA",
    "E2E_AUTH_COOKIE_DOMAIN",
  ].filter((key) => env[key] !== undefined);
  if (forbidden.length > 0) {
    throw new Error(
      `Deployed QA is non-destructive and refuses database/reset variables: ${forbidden.join(", ")}.`,
    );
  }
  return { ...env, E2E_DEPLOYED_QA: "true" };
}

async function runPlaywright(
  playwrightArgs,
  env,
  runCommand,
  signal,
  beforeSpawn,
) {
  const invocation = npmInvocation(
    ["test", "--prefix", "e2e", "--", ...playwrightArgs],
    env,
  );
  signal?.throwIfAborted();
  beforeSpawn?.();
  const result = await runCommand(invocation.command, invocation.args, {
    env,
    signal,
  });
  return result.code;
}

async function runDeployedQa(playwrightArgs, env, dependencies) {
  if (dependencies.validateOnly) {
    throw new Error(
      "--validate-only applies only to the local disposable Compose stack.",
    );
  }
  dependencies.signal?.throwIfAborted();
  const safeEnv = deployedQaEnvironment(env);
  process.stdout.write(
    "Running non-destructive deployed browser QA; no database reset path is configured.\n",
  );
  dependencies.signal?.throwIfAborted();
  return runPlaywright(
    playwrightArgs,
    safeEnv,
    dependencies.runCommand,
    dependencies.signal,
    dependencies.beforePlaywrightSpawn,
  );
}

function requireStrongRuntimeSecret(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length < 32) {
    throw new Error(
      `${name} must be an explicit high-entropy secret for remote-disposable execution.`,
    );
  }
  return value;
}

export async function verifyApiDatabaseBinding(config, env, fetchFn = fetch) {
  const readinessKey = requireStrongRuntimeSecret(env, "E2E_READINESS_API_KEY");
  let response;
  try {
    response = await fetchFn(
      `${config.apiUrl}/api/v1/health/e2e-database-identity`,
      {
        method: "GET",
        redirect: "error",
        headers: { "x-charitypilot-readiness-key": readinessKey },
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new Error(
      "Remote E2E API database-binding preflight failed (details redacted).",
    );
  }
  if (response.status !== 200) {
    throw new Error(
      "Remote E2E API database-binding preflight was not authorised or not bound.",
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      "Remote E2E API database-binding preflight returned an invalid response.",
    );
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    JSON.stringify(Object.keys(body).sort()) !==
      JSON.stringify(["instanceId", "status"]) ||
    body.status !== "bound" ||
    body.instanceId !== config.instanceId
  ) {
    throw new Error(
      "Remote E2E API is not bound to the independently verified disposable database instance.",
    );
  }
}

function remoteDatabaseClientConstructor() {
  try {
    return createRequire(join(ROOT, "e2e", "package.json"))("pg").Client;
  } catch {
    throw new Error(
      "Remote E2E database operations require installed e2e dependencies (run npm ci --prefix e2e).",
    );
  }
}

function createRemoteDatabaseClient(config) {
  const Client = remoteDatabaseClientConstructor();
  return new Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
}

function remoteCleanupFailure(label, error, secrets) {
  const detail = redactSecrets(error?.message ?? error ?? "", secrets)
    .trim()
    .replace(/\s+/gu, " ");
  return `${label}: ${detail || "failed with redacted details"}`;
}

async function boundedRemoteJanitorStep(label, timeoutMs, operation) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => {
          rejectPromise(
            new Error(`${label} exceeded its bounded cleanup time.`),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function janitorRemoteDisposableDatabase(
  config,
  env,
  options = {},
) {
  if (!config?.isRemote) {
    throw new Error(
      "Remote disposable janitor requires a preflight-verified remote database config.",
    );
  }
  const require = createRequire(import.meta.url);
  const safety = require("../e2e/helpers/database-safety.cjs");
  const clientFactory = options.clientFactory ?? createRemoteDatabaseClient;
  const queryIdentity =
    options.queryAndAssertDatabaseIdentity ??
    safety.queryAndAssertDatabaseIdentity;
  const acquireLease =
    options.acquireRemoteSuiteAdvisoryLeaseBounded ??
    safety.acquireRemoteSuiteAdvisoryLeaseBounded;
  const resetDatabase =
    options.resetDisposableDatabase ?? safety.resetDisposableDatabase;
  const releaseLease =
    options.releaseRemoteSuiteAdvisoryLease ??
    safety.releaseRemoteSuiteAdvisoryLease;
  const verifyBinding =
    options.verifyApiDatabaseBinding ?? verifyApiDatabaseBinding;
  const resetTables =
    options.resetTables ?? safety.DISPOSABLE_DATABASE_RESET_TABLES;
  const leaseOptions = options.leaseOptions ?? {};
  const secrets = ambientSecretCandidates(env);
  const failures = [];
  let client;
  let connected = false;
  let leaseAcquired = false;

  try {
    client = clientFactory(config);
    try {
      await boundedRemoteJanitorStep(
        "Remote disposable janitor connection",
        REMOTE_JANITOR_TIMEOUTS.connect,
        () => client.connect(),
      );
      connected = true;
    } catch (error) {
      throw safety.safeDatabaseOperationError(
        "Remote disposable janitor connection",
        error,
      );
    }
    await boundedRemoteJanitorStep(
      "Remote disposable janitor identity proof",
      REMOTE_JANITOR_TIMEOUTS.identity,
      () => queryIdentity(client, config),
    );
    await boundedRemoteJanitorStep(
      "Remote disposable janitor suite lease",
      REMOTE_JANITOR_TIMEOUTS.lease,
      () => acquireLease(client, config, leaseOptions),
    );
    leaseAcquired = true;
    // Re-prove the application binding only after the dead child's session lease
    // has been recovered. A split or changed target must never be reset.
    await boundedRemoteJanitorStep(
      "Remote disposable janitor pre-reset API binding",
      REMOTE_JANITOR_TIMEOUTS.binding,
      () => verifyBinding(config, env, options.fetchFn ?? fetch),
    );
    await boundedRemoteJanitorStep(
      "Remote disposable janitor reset",
      REMOTE_JANITOR_TIMEOUTS.reset,
      () => resetDatabase(client, config, resetTables),
    );
    await boundedRemoteJanitorStep(
      "Remote disposable janitor post-reset API binding",
      REMOTE_JANITOR_TIMEOUTS.binding,
      () => verifyBinding(config, env, options.fetchFn ?? fetch),
    );
  } catch (error) {
    failures.push(remoteCleanupFailure("remote cleanup", error, secrets));
  } finally {
    if (leaseAcquired) {
      try {
        await boundedRemoteJanitorStep(
          "Remote disposable janitor lease release",
          REMOTE_JANITOR_TIMEOUTS.release,
          () => releaseLease(client, config),
        );
      } catch (error) {
        failures.push(
          remoteCleanupFailure("remote lease release", error, secrets),
        );
      }
    }
    if (client) {
      try {
        await boundedRemoteJanitorStep(
          "Remote disposable janitor disconnect",
          REMOTE_JANITOR_TIMEOUTS.disconnect,
          () => client.end(),
        );
      } catch (error) {
        failures.push(
          remoteCleanupFailure(
            connected
              ? "remote database disconnect"
              : "failed-connection disposal",
            error,
            secrets,
          ),
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Remote disposable E2E outer cleanup failed closed; no green result is possible. ${failures.join("; ")}`,
    );
  }
}

export async function verifyRemoteDatabaseIdentity(env) {
  const require = createRequire(import.meta.url);
  const {
    loadDisposableDatabaseConfig,
    queryAndAssertDatabaseIdentity,
    safeDatabaseOperationError,
  } = require("../e2e/helpers/database-safety.cjs");
  const config = loadDisposableDatabaseConfig(env);
  if (!config.isRemote)
    throw new Error(
      "Remote runner preflight did not resolve remote-disposable mode.",
    );

  const client = createRemoteDatabaseClient(config);
  try {
    await client.connect();
    await queryAndAssertDatabaseIdentity(client, config);
  } catch (error) {
    throw safeDatabaseOperationError(
      "Remote disposable database preflight",
      error,
    );
  } finally {
    try {
      await client.end();
    } catch {
      // The preflight result remains failed or complete; never expose connection details.
    }
  }
  return config;
}

async function runRemoteDisposable(playwrightArgs, env, dependencies) {
  if (dependencies.validateOnly) {
    throw new Error(
      "--validate-only applies only to the local disposable Compose stack.",
    );
  }
  requireStrongRuntimeSecret(env, "E2E_READINESS_API_KEY");
  requireStrongRuntimeSecret(env, "E2E_JWT_SECRET");

  dependencies.signal?.throwIfAborted();
  const config = await dependencies.databasePreflight(env);
  if (!config?.isRemote)
    throw new Error(
      "Remote runner preflight did not prove remote-disposable mode.",
    );
  dependencies.signal?.throwIfAborted();
  await verifyApiDatabaseBinding(config, env, dependencies.fetchFn);
  dependencies.signal?.throwIfAborted();
  dependencies.onAuthorized?.(config);
  process.stdout.write(
    "Remote disposable database and API binding were independently verified.\n",
  );
  dependencies.signal?.throwIfAborted();
  return runPlaywright(
    playwrightArgs,
    env,
    dependencies.runCommand,
    dependencies.signal,
    dependencies.beforePlaywrightSpawn,
  );
}

export async function runIsolatedE2e(
  argv = process.argv.slice(2),
  options = {},
) {
  const env = options.env ?? process.env;
  const parsed = parseRunnerArgs(argv);
  let activeChild = null;
  let receivedSignal = null;
  let cleanupStarted = false;
  let exactTreeShutdownChild = null;
  let exactTreeShutdownPromise = null;
  let exactTreeShutdownFailure = null;
  const shutdownController = new AbortController();
  const overallTimeoutMs = resolveOverallRunnerTimeoutMs(
    env,
    options.overallTimeoutMs,
  );
  const trackChild = (child, completedChild) => {
    if (child) {
      activeChild = child;
    } else if (!completedChild || activeChild === completedChild) {
      activeChild = null;
    }
  };
  const beginExactTreeShutdown = (child) => {
    if (!child?.pid) return Promise.resolve();
    if (exactTreeShutdownChild === child && exactTreeShutdownPromise) {
      return exactTreeShutdownPromise;
    }
    exactTreeShutdownChild = child;
    exactTreeShutdownPromise = stopAndWaitForExactChildTree(
      child,
      options.childShutdownOptions,
    ).catch((error) => {
      exactTreeShutdownFailure ??= error;
      throw error;
    });
    // Signal/timer callbacks start this promise without awaiting it. Attach a
    // rejection observer immediately; finalizers still await the same promise.
    void exactTreeShutdownPromise.catch(() => undefined);
    return exactTreeShutdownPromise;
  };
  const awaitExactTreeShutdownProof = async () => {
    if (activeChild && exactTreeShutdownChild !== activeChild) {
      await beginExactTreeShutdown(activeChild);
    } else if (exactTreeShutdownPromise) {
      await exactTreeShutdownPromise;
    }
    if (exactTreeShutdownFailure) throw exactTreeShutdownFailure;
  };
  const requestShutdown = (reason) => {
    receivedSignal ??= reason;
    if (!shutdownController.signal.aborted) {
      shutdownController.abort(
        new Error(`Isolated E2E interrupted by ${reason}.`),
      );
    }
    // Never throw from a signal/timer callback. Start one checked, bounded
    // shutdown proof for the retained exact child/group identity; finalizers
    // await and gate cleanup on that same promise.
    if (!cleanupStarted && activeChild) {
      void beginExactTreeShutdown(activeChild);
    }
  };
  const onSigint = () => requestShutdown("SIGINT");
  const onSigterm = () => requestShutdown("SIGTERM");
  const timeout = setTimeout(
    () => requestShutdown("TIMEOUT"),
    overallTimeoutMs,
  );
  timeout.unref();
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  const removeLifecycleHandlers = () => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    clearTimeout(timeout);
  };
  const signalFailure = (cleanupLabel) => {
    const error = new Error(
      `Isolated E2E interrupted by ${receivedSignal}; ${cleanupLabel} completed.`,
    );
    error.exitCode =
      receivedSignal === "TIMEOUT"
        ? 124
        : receivedSignal === "SIGINT"
          ? 130
          : 143;
    return error;
  };
  const ambientSecrets = ambientSecretCandidates(env);
  const preliminaryRunner =
    options.runCommand ??
    createCommandRunner({
      secrets: ambientSecrets,
      onChild: trackChild,
      shutdownChild: beginExactTreeShutdown,
      defaultSignal: shutdownController.signal,
      spawnFn: options.spawnFn ?? spawn,
    });

  const finalizeNonLocalRun = async ({
    remoteAuthorized = false,
    remoteConfig = null,
  } = {}) => {
    const failures = [];
    let exactTreeAbsenceProven = true;
    try {
      await awaitExactTreeShutdownProof();
    } catch (error) {
      exactTreeAbsenceProven = false;
      failures.push(
        remoteCleanupFailure(
          "exact child-tree shutdown unproven; manual process and database recovery is required and the remote janitor was skipped",
          error,
          ambientSecrets,
        ),
      );
    }
    cleanupStarted = true;
    if (remoteAuthorized && exactTreeAbsenceProven) {
      try {
        await (
          options.remoteDatabaseJanitor ?? janitorRemoteDisposableDatabase
        )(remoteConfig, env, options.remoteJanitorOptions);
      } catch (error) {
        failures.push(
          remoteCleanupFailure("outer remote janitor", error, ambientSecrets),
        );
      }
    }
    removeLifecycleHandlers();
    if (failures.length > 0) {
      throw new Error(
        `Isolated E2E non-local cleanup failed closed; no green result is possible. ${failures.join("; ")}`,
      );
    }
    if (receivedSignal) throw signalFailure("bounded non-local cleanup");
  };

  if (env.E2E_DEPLOYED_QA === "true") {
    try {
      return await runDeployedQa(parsed.playwrightArgs, env, {
        validateOnly: parsed.validateOnly,
        runCommand: preliminaryRunner,
        signal: shutdownController.signal,
        beforePlaywrightSpawn: () =>
          options.beforePlaywrightSpawn?.({
            mode: "deployed-qa",
            requestShutdown,
            signal: shutdownController.signal,
          }),
      });
    } finally {
      await finalizeNonLocalRun();
    }
  }
  if (env.E2E_EXECUTION_MODE === "remote-disposable") {
    let remoteAuthorized = false;
    let remoteConfig = null;
    try {
      if (process.platform === "win32") {
        throw new Error(
          "remote-disposable E2E is forbidden on native Windows until the runner has a Job Object-backed exact process-tree lifetime primitive.",
        );
      }
      return await runRemoteDisposable(parsed.playwrightArgs, env, {
        validateOnly: parsed.validateOnly,
        runCommand: preliminaryRunner,
        fetchFn: options.fetchFn ?? fetch,
        databasePreflight:
          options.remoteDatabasePreflight ?? verifyRemoteDatabaseIdentity,
        signal: shutdownController.signal,
        beforePlaywrightSpawn: () =>
          options.beforePlaywrightSpawn?.({
            mode: "remote-disposable",
            requestShutdown,
            signal: shutdownController.signal,
          }),
        onAuthorized: (config) => {
          remoteConfig = config;
          remoteAuthorized = true;
        },
      });
    } finally {
      await finalizeNonLocalRun({ remoteAuthorized, remoteConfig });
    }
  }

  let identity;
  let tempRoot;
  try {
    assertNoAmbientLocalAuthority(env);
    assertNoDockerEndpointOverrides(env);
    identity = options.identity ?? createLocalRunIdentity();
    tempRoot = await mkdtemp(join(tmpdir(), "charitypilot-e2e-"));
    options.onTempRoot?.(tempRoot);
  } catch (error) {
    if (tempRoot)
      await rm(tempRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    removeLifecycleHandlers();
    throw error;
  }
  const envFile = join(tempRoot, "compose.env");
  const composeSnapshotFile = join(tempRoot, "compose.e2e.snapshot.yml");
  const composeSourcePath = options.composeSourcePath ?? COMPOSE_FILE;
  const composeSourceReader = options.composeSourceReader ?? readFile;
  const composeSnapshotWriter = options.composeSnapshotWriter ?? writeFile;
  const removePath = options.removePath ?? rm;
  let stackWasAddressed = false;
  let buildContextCreated = false;
  let validatedDockerEndpoint = null;
  let cleanupPromise = null;
  const runCommand =
    options.runCommand ??
    createCommandRunner({
      secrets: identity.secrets,
      onChild: trackChild,
      shutdownChild: beginExactTreeShutdown,
      defaultSignal: shutdownController.signal,
      spawnFn: options.spawnFn ?? spawn,
    });
  const cleanupRunCommand =
    options.cleanupRunCommand ??
    options.runCommand ??
    createCommandRunner({
      secrets: identity.secrets,
      onChild: trackChild,
      shutdownChild: beginExactTreeShutdown,
      spawnFn: options.cleanupSpawnFn ?? spawn,
    });
  const composeChildEnv = { ...env };
  for (const key of Object.keys(composeChildEnv)) {
    if (key.startsWith("E2E_") || key.startsWith("COMPOSE_"))
      delete composeChildEnv[key];
  }

  const recoveryFailure = (message, cause) => {
    const detail = redactSecrets(cause?.message ?? "", identity.secrets).trim();
    const error = new Error(
      `${message}; private cleanup material remains at ${tempRoot}.` +
        (detail ? `\n${detail}` : ""),
    );
    error.recoveryDirectory = tempRoot;
    if (Number.isInteger(cause?.exitCode)) error.exitCode = cause.exitCode;
    return error;
  };

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (stackWasAddressed) {
        let result;
        try {
          result = await cleanupRunCommand(
            "docker",
            daemonComposeInvocation(
              validatedDockerEndpoint,
              identity.projectName,
              envFile,
              composeSnapshotFile,
              "down",
              "--volumes",
              "--remove-orphans",
              "--rmi",
              "all",
              "--timeout",
              "15",
            ),
            {
              allowFailure: true,
              capture: true,
              env: composeChildEnv,
              timeoutMs: 600_000,
            },
          );
        } catch (error) {
          throw recoveryFailure(
            "Isolated E2E teardown command failed or timed out; the run is not green",
            error,
          );
        }
        if (result.code !== 0) {
          const detail = redactSecrets(
            result.stderr || result.stdout,
            identity.secrets,
          ).trim();
          throw recoveryFailure(
            "Isolated E2E teardown failed; the run is not green",
            detail ? new Error(detail) : undefined,
          );
        }

        const resourceChecks = [
          [
            "--host",
            validatedDockerEndpoint,
            "ps",
            "--all",
            "--quiet",
            "--filter",
            `label=com.docker.compose.project=${identity.projectName}`,
          ],
          [
            "--host",
            validatedDockerEndpoint,
            "volume",
            "ls",
            "--quiet",
            "--filter",
            `label=com.docker.compose.project=${identity.projectName}`,
          ],
          [
            "--host",
            validatedDockerEndpoint,
            "network",
            "ls",
            "--quiet",
            "--filter",
            `label=com.docker.compose.project=${identity.projectName}`,
          ],
          [
            "--host",
            validatedDockerEndpoint,
            "image",
            "ls",
            "--quiet",
            identity.appImage,
          ],
          [
            "--host",
            validatedDockerEndpoint,
            "image",
            "ls",
            "--quiet",
            identity.databaseImage,
          ],
          [
            "--host",
            validatedDockerEndpoint,
            "image",
            "ls",
            "--quiet",
            identity.gatewayImage,
          ],
        ];
        for (const args of resourceChecks) {
          let residue;
          try {
            residue = await cleanupRunCommand("docker", args, {
              capture: true,
              env: composeChildEnv,
              timeoutMs: LOCAL_RESIDUE_CHECK_TIMEOUT_MS,
            });
          } catch (error) {
            throw recoveryFailure(
              "Isolated E2E residue verification failed or timed out",
              error,
            );
          }
          if (residue.stdout.trim() !== "") {
            throw recoveryFailure(
              "Isolated E2E teardown left exact-project Docker resources",
            );
          }
        }
      }
      if (buildContextCreated) {
        try {
          await removePath(identity.buildContextPath, {
            recursive: true,
            force: true,
          });
        } catch (error) {
          throw recoveryFailure(
            "Isolated E2E build-context deletion failed",
            error,
          );
        }
      }
      try {
        await removePath(tempRoot, { recursive: true, force: true });
      } catch (error) {
        throw recoveryFailure(
          "Isolated E2E private temporary-state deletion failed",
          error,
        );
      }
    })();
    return cleanupPromise;
  };

  try {
    const composeSourceBytes = await composeSourceReader(composeSourcePath);
    if (
      !Buffer.isBuffer(composeSourceBytes) &&
      !(composeSourceBytes instanceof Uint8Array)
    ) {
      throw new Error("Compose source reader did not return exact file bytes.");
    }
    let composeSourceText;
    try {
      composeSourceText = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(composeSourceBytes);
    } catch {
      throw new Error(
        "Standalone isolated Compose source must be valid UTF-8.",
      );
    }
    assertStandaloneComposeSource(composeSourceText);
    await composeSnapshotWriter(composeSnapshotFile, composeSourceText, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") await chmod(composeSnapshotFile, 0o600);

    await (options.buildContextCreator ?? createIsolatedBuildContext)(
      ROOT,
      identity.buildContextPath,
    );
    buildContextCreated = true;
    await writeFile(envFile, serializeEnvFile(identity.composeEnv), {
      encoding: "utf8",
      mode: 0o600,
    });
    options.onProject?.(identity.projectName);
    if (process.platform !== "win32") await chmod(envFile, 0o600);
    await (options.portChecker ?? assertLoopbackPortsAvailable)();
    shutdownController.signal.throwIfAborted();

    const rendered = await runCommand(
      "docker",
      composeInvocation(
        identity.projectName,
        envFile,
        composeSnapshotFile,
        "config",
        "--no-env-resolution",
        "--format",
        "json",
      ),
      { capture: true, env: composeChildEnv, timeoutMs: 60_000 },
    );
    shutdownController.signal.throwIfAborted();
    let composeModel;
    try {
      composeModel = JSON.parse(rendered.stdout);
    } catch {
      throw new Error("docker compose config did not emit valid JSON.");
    }
    validateRenderedCompose(
      composeModel,
      identity.projectName,
      ROOT,
      identity.buildContextPath,
      identity,
    );

    if (parsed.validateOnly) {
      process.stdout.write(
        "Isolated E2E Compose configuration passed static validation; no containers were started.\n",
      );
      return 0;
    }

    validatedDockerEndpoint = await verifyLocalDockerContext(
      runCommand,
      composeChildEnv,
    );
    await verifyIntegratedLocalBuilder(
      runCommand,
      composeChildEnv,
      validatedDockerEndpoint,
    );
    shutdownController.signal.throwIfAborted();
    stackWasAddressed = true;
    process.stdout.write(
      `Starting isolated E2E stack ${identity.projectName}; generated credentials are hidden.\n`,
    );
    await runCommand(
      "docker",
      daemonComposeInvocation(
        validatedDockerEndpoint,
        identity.projectName,
        envFile,
        composeSnapshotFile,
        "build",
        "--builder",
        "default",
      ),
      { env: composeChildEnv, timeoutMs: LOCAL_COMPOSE_BUILD_TIMEOUT_MS },
    );
    shutdownController.signal.throwIfAborted();
    const builtAttestation = await (
      options.captureBuiltImageAttestation ?? captureBuiltImageAttestation
    )(runCommand, validatedDockerEndpoint, identity, composeChildEnv);
    shutdownController.signal.throwIfAborted();
    await runCommand(
      "docker",
      daemonComposeInvocation(
        validatedDockerEndpoint,
        identity.projectName,
        envFile,
        composeSnapshotFile,
        "up",
        "--no-build",
        "--pull",
        "never",
        "--detach",
        "--wait",
        "--wait-timeout",
        "720",
      ),
      { env: composeChildEnv, timeoutMs: 780_000 },
    );
    shutdownController.signal.throwIfAborted();
    await (
      options.captureRunningContainerAttestation ??
      captureRunningContainerAttestation
    )(
      runCommand,
      validatedDockerEndpoint,
      identity,
      composeChildEnv,
      builtAttestation,
    );
    shutdownController.signal.throwIfAborted();
    await Promise.all([
      waitForEndpoint(
        `${LOCAL_CONTRACT.apiUrl}/api/v1/health`,
        "Isolated API",
        {
          ...options.waitOptions,
          signal: shutdownController.signal,
        },
      ),
      waitForEndpoint(`${LOCAL_CONTRACT.webUrl}/`, "Isolated web app", {
        ...options.waitOptions,
        timeoutMs: options.waitOptions?.timeoutMs ?? 600_000,
        signal: shutdownController.signal,
      }),
    ]);
    shutdownController.signal.throwIfAborted();

    const playwrightEnv = {
      ...env,
      ...identity.playwrightEnv,
    };
    return await runPlaywright(
      parsed.playwrightArgs,
      playwrightEnv,
      runCommand,
      shutdownController.signal,
      () =>
        options.beforePlaywrightSpawn?.({
          mode: "local-disposable",
          requestShutdown,
          signal: shutdownController.signal,
        }),
    );
  } catch (error) {
    if (
      stackWasAddressed &&
      !parsed.validateOnly &&
      !receivedSignal &&
      !exactTreeShutdownFailure
    ) {
      try {
        const logs = await runCommand(
          "docker",
          daemonComposeInvocation(
            validatedDockerEndpoint,
            identity.projectName,
            envFile,
            composeSnapshotFile,
            "logs",
            "--no-color",
            "--tail",
            "300",
          ),
          {
            allowFailure: true,
            capture: true,
            env: composeChildEnv,
            timeoutMs: 30_000,
          },
        );
        const output = redactSecrets(
          `${logs.stdout}\n${logs.stderr}`,
          identity.secrets,
        ).trim();
        if (output)
          process.stderr.write(
            `\nIsolated E2E stack logs (secrets redacted):\n${output}\n`,
          );
      } catch {
        process.stderr.write(
          "\nIsolated E2E stack logs could not be collected; preserving the original failure.\n",
        );
      }
    }
    throw error;
  } finally {
    let treeProofError;
    try {
      await awaitExactTreeShutdownProof();
    } catch (error) {
      treeProofError = error;
    }
    cleanupStarted = true;
    if (treeProofError) {
      removeLifecycleHandlers();
      throw recoveryFailure(
        "Exact operational child-tree absence was not proved; Docker cleanup was not started and manual process/stack recovery is required",
        treeProofError,
      );
    }
    try {
      await cleanup();
    } finally {
      removeLifecycleHandlers();
    }
    if (receivedSignal) {
      throw signalFailure("stack cleanup");
    }
  }
}

async function main() {
  try {
    const code = await runIsolatedE2e();
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(
      `Isolated E2E failed: ${redactSecrets(error?.message ?? error)}\n`,
    );
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
