import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const deployScriptPath = join(scriptsDir, "production-compose-deploy.mjs");
const digest = "a".repeat(64);
const productionSupabaseUrl = "https://xjvdkmqbtczrnlqpswfa.supabase.co";
const backupOutputDir = join(
  tmpdir(),
  "charitypilot-approved-encrypted-cutover",
);
const backupArgs = ["--backup-output-dir", backupOutputDir];

function cleanEnv() {
  return {
    PATH: process.env.PATH ?? "",
    Path: process.env.Path ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    WINDIR: process.env.WINDIR ?? "",
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
  };
}

async function loadDeployRunner() {
  assert.ok(
    existsSync(deployScriptPath),
    "production compose deploy script must exist",
  );
  const module = await import(pathToFileURL(deployScriptPath).href);
  assert.equal(typeof module.runProductionComposeDeployFromArgs, "function");
  return (args, dependencies = {}) =>
    module.runProductionComposeDeployFromArgs(args, {
      cutoverLockPath: join(
        tmpdir(),
        `charitypilot-deploy-test-${process.pid}.lock`,
      ),
      ...dependencies,
    });
}

async function loadDeployModule() {
  assert.ok(
    existsSync(deployScriptPath),
    "production compose deploy script must exist",
  );
  return import(pathToFileURL(deployScriptPath).href);
}

function successfulBackup(calls = null) {
  return (args, env) => {
    calls?.push({ type: "backup", args, env });
    return { status: 0, stdout: "backup ok\n", stderr: "" };
  };
}

function completeDeployEnv(overrides = {}) {
  const values = {
    NODE_ENV: "production",
    PORT: "3002",
    TRUSTED_PROXY_ADDRESSES: "10.0.0.10",
    READINESS_API_KEY: "r7Nq2Xc9Lm4Pz8Va6Ys3Td5He1Bw0UkF",
    DATABASE_URL:
      "postgresql://user:pass@db.charitypilot.ie:5432/charitypilot?sslmode=verify-full&target_session_attrs=read-write",
    DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST: "db.charitypilot.ie",
    JWT_SECRET: "J9mQ4vRx7tL2pZs6NfB8hDy3WcK1uEa5",
    FRONTEND_URL: "https://app.charitypilot.ie",
    AUTH_COOKIE_DOMAIN: ".charitypilot.ie",
    STRIPE_SECRET_KEY: "sk_live_configuredSecret",
    STRIPE_WEBHOOK_SECRET: "whsec_configuredSecret",
    STRIPE_ESSENTIALS_MONTHLY_PRICE_ID: "price_essentialsMonthly",
    STRIPE_ESSENTIALS_YEARLY_PRICE_ID: "price_essentialsYearly",
    STRIPE_COMPLETE_MONTHLY_PRICE_ID: "price_completeMonthly",
    STRIPE_COMPLETE_YEARLY_PRICE_ID: "price_completeYearly",
    STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_configuredPortal",
    RESEND_API_KEY: "re_configuredSecret",
    EMAIL_FROM: "noreply@charitypilot.ie",
    SUPABASE_URL: productionSupabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: "configured-service-role-key",
    SUPABASE_STORAGE_BUCKET: "documents",
    ERROR_ALERT_WEBHOOK_URL:
      "https://alerts.charitypilot.ie/hooks/charitypilot",
    NEXT_PUBLIC_API_URL: "https://api.charitypilot.ie",
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_configuredSecret",
    CHARITYPILOT_WEB_NEXT_PUBLIC_API_URL: "https://api.charitypilot.ie",
    CADDY_ACME_EMAIL: "ops@charitypilot.ie",
    CHARITYPILOT_WEB_DOMAIN: "app.charitypilot.ie",
    CHARITYPILOT_API_DOMAIN: "api.charitypilot.ie",
    CHARITYPILOT_API_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${digest}`,
    CHARITYPILOT_WEB_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${digest}`,
    CHARITYPILOT_MIGRATION_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${digest}`,
    CHARITYPILOT_DATABASE_COMPATIBILITY: "p109-governance-integrity-v1",
    CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL: "https://api.charitypilot.ie",
    ...overrides,
  };

  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

test("production deploy dry-run validates preflight before rendering compose up", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-deploy-dry-run-"),
  );
  const envPath = join(tempDir, "production.env");

  writeFileSync(envPath, completeDeployEnv());

  try {
    const result = runProductionComposeDeployFromArgs(
      ["--production-env-file", envPath, ...backupArgs, "--dry-run"],
      { processEnv: cleanEnv() },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production compose deploy dry-run/);
    const preflightIndex = result.stdout.indexOf(
      "node scripts/production-deploy-preflight.mjs",
    );
    const quiesceIndex = result.stdout.indexOf("down --remove-orphans");
    const backupIndex = result.stdout.indexOf(
      "node scripts/check-production-database.mjs",
    );
    const migrateIndex = result.stdout.indexOf("run --rm --no-deps migrate");
    const deployIndex = result.stdout.indexOf(
      "up --wait --wait-timeout 180 -d --remove-orphans",
    );
    assert.ok(preflightIndex > -1, "dry-run must show the preflight command");
    assert.ok(
      quiesceIndex > -1,
      "dry-run must show the fail-closed runtime shutdown",
    );
    assert.ok(
      backupIndex > -1,
      "dry-run must show the retained backup/restore verification",
    );
    assert.ok(migrateIndex > -1, "dry-run must show migration running alone");
    assert.ok(deployIndex > -1, "dry-run must show the promoted runtime start");
    assert.ok(
      preflightIndex < quiesceIndex,
      "preflight must run before maintenance mode",
    );
    assert.ok(
      quiesceIndex < backupIndex,
      "the old runtime must stop before the final backup",
    );
    assert.ok(
      backupIndex < migrateIndex,
      "backup verification must pass before migration",
    );
    assert.ok(
      migrateIndex < deployIndex,
      "migration must finish before the promoted runtime starts",
    );
    assert.match(result.stdout, /--dry-run/);
    assert.match(
      result.stdout,
      /Compose environment:\nCHARITYPILOT_PRODUCTION_ENV_FILE=/,
    );
    assert.match(
      result.stdout,
      /Start only the promoted runtime:\ndocker compose --env-file/,
    );
    assert.match(
      result.stdout,
      /Post-deploy smoke command:\nnode scripts\/smoke-production-deploy\.mjs/,
    );
    assert.doesNotMatch(
      result.stdout,
      /CHARITYPILOT_PRODUCTION_ENV_FILE=.*docker compose --env-file/,
    );
    assert.doesNotMatch(result.stdout, /[A-Z]:\\\\/);
    assert.match(
      result.stdout,
      /up --wait --wait-timeout 180 -d --remove-orphans/,
    );
    assert.match(
      result.stdout,
      /--backup-output-dir "<approved-backup-dir>" --keep-backup/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production deploy dry-run aborts before compose up when preflight fails", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-deploy-preflight-fail-"),
  );
  const envPath = join(tempDir, "production.env");

  writeFileSync(
    envPath,
    completeDeployEnv({
      CHARITYPILOT_API_IMAGE:
        "ghcr.io/jasperfordesq-ai/charity-governance-api:sha-test",
    }),
  );

  try {
    const result = runProductionComposeDeployFromArgs(
      ["--production-env-file", envPath, ...backupArgs, "--dry-run"],
      { processEnv: cleanEnv() },
    );

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Production compose deploy failed: preflight failed/,
    );
    assert.match(
      result.stderr,
      /CHARITYPILOT_API_IMAGE must be pinned to an immutable sha256 digest/,
    );
    assert.doesNotMatch(result.stdout, /up --wait/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production deploy quiesces and backs up the old runtime before migration and promoted startup", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const envPath = join(tmpdir(), "charitypilot-selected-production.env");
  const calls = [];

  const result = runProductionComposeDeployFromArgs(
    ["--production-env-file", envPath, ...backupArgs, "--wait-timeout", "240"],
    {
      processEnv: cleanEnv(),
      runPreflight: (args, env) => {
        calls.push({ type: "preflight", args, env });
        return { status: 0, stdout: "preflight ok\n", stderr: "" };
      },
      runCommand: (command, env) => {
        calls.push({ type: "command", command, env });
      },
      runBackup: successfulBackup(calls),
      runSmoke: (args, env) => {
        calls.push({ type: "smoke", args, env });
        return { status: 0, stdout: "smoke ok\n", stderr: "" };
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    calls.map((call) => call.type),
    [
      "preflight",
      "command",
      "command",
      "backup",
      "command",
      "command",
      "command",
      "command",
      "smoke",
    ],
  );
  assert.deepEqual(calls[0].args, ["--production-env-file", envPath]);
  assert.deepEqual(calls[1].command.slice(-8), [
    "--profile",
    "maintenance",
    "pull",
    "migrate",
    "api",
    "web",
    "production-scheduler",
    "caddy",
  ]);
  assert.deepEqual(calls[2].command.slice(-6), [
    "--profile",
    "maintenance",
    "--profile",
    "jobs",
    "down",
    "--remove-orphans",
  ]);
  assert.deepEqual(calls[4].command.slice(-6), [
    "--profile",
    "maintenance",
    "run",
    "--rm",
    "--no-deps",
    "migrate",
  ]);
  assert.deepEqual(calls[5].command.slice(-10), [
    "--profile",
    "maintenance",
    "run",
    "--rm",
    "--no-deps",
    "migrate",
    "migrate",
    "status",
    "--schema",
    "prisma/schema.prisma",
  ]);
  assert.deepEqual(calls[6].command.slice(-8), [
    "run",
    "--rm",
    "--no-deps",
    "api",
    "node",
    "dist/jobs/reconcile-deadline-reminder.js",
    "--prepare-quiesced-cutover",
    "--confirm-schedulers-quiesced",
  ]);
  assert.deepEqual(calls[7].command, [
    "docker",
    "compose",
    "--env-file",
    envPath,
    "-f",
    "compose.production.yml",
    "-f",
    "compose.production-tls.yml",
    "up",
    "--wait",
    "--wait-timeout",
    "240",
    "-d",
    "--remove-orphans",
  ]);
  assert.equal(calls[7].env.CHARITYPILOT_PRODUCTION_ENV_FILE, envPath);
  assert.deepEqual(calls[8].args, ["--production-env-file", envPath]);
  assert.equal(calls[8].env.CHARITYPILOT_PRODUCTION_ENV_FILE, envPath);
  assert.deepEqual(calls[3].args.slice(0, 2), [
    "--production-env-file",
    envPath,
  ]);
  assert.ok(calls[3].args[3].startsWith(backupOutputDir));
  assert.equal(calls[3].args[4], "--keep-backup");
  assert.match(result.stdout, /preflight ok/);
  assert.match(result.stdout, /smoke ok/);
  assert.match(
    result.stdout,
    /P0-06 quiesced reminder cutover preparation completed with zero unresolved reminder outcomes\./,
  );
  assert.match(result.stdout, /Production compose deploy completed/);
});

test("production deploy keeps runtime stopped when reminder cutover preparation finds unresolved delivery state", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const calls = [];
  let smokeCalled = false;
  const result = runProductionComposeDeployFromArgs(
    ["--production-env-file", "production.env", ...backupArgs],
    {
      processEnv: cleanEnv(),
      runPreflight: () => ({ status: 0, stdout: "preflight ok\n", stderr: "" }),
      runCommand: (command) => {
        calls.push(command);
        if (command.includes("--prepare-quiesced-cutover")) {
          throw new Error("2 unresolved deadline reminder outcome(s) block runtime start");
        }
      },
      runBackup: successfulBackup(),
      runSmoke: () => {
        smokeCalled = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(result.status, 1);
  assert.equal(smokeCalled, false);
  assert.match(result.stderr, /unresolved deadline reminder outcome/);
  assert.equal(calls.some((command) => command.includes("up")), false);
  assert.match(calls.at(-1).join(" "), /down --remove-orphans$/);
});

test("attested pre-P0-06 restore skips only the unavailable P0-06 reminder gate", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const calls = [];
  let preflightOptions;
  const result = runProductionComposeDeployFromArgs(
    ["--production-env-file", "production.env", ...backupArgs],
    {
      processEnv: cleanEnv(),
      attestedDatabaseCompatibility: "pre-p006-restored",
      runPreflight: (_args, _env, options) => {
        preflightOptions = options;
        return { status: 0, stdout: "preflight ok\n", stderr: "" };
      },
      runCommand: (command) => calls.push(command),
      runBackup: successfulBackup(),
      runSmoke: () => ({ status: 0, stdout: "smoke ok\n", stderr: "" }),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(preflightOptions, {
    expectedDatabaseCompatibility: "pre-p006-restored",
  });
  assert.equal(
    calls.some((command) => command.includes("reconcile-deadline-reminder.js")),
    false,
  );
  assert.ok(calls.some((command) => command.includes("up")));
  assert.doesNotMatch(result.stdout, /quiesced reminder cutover preparation/);
});

test("attested restored P0-06 line uses its exact preflight marker without skipping reconciliation", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const calls = [];
  let preflightOptions;
  const result = runProductionComposeDeployFromArgs(
    ["--production-env-file", "production.env", ...backupArgs],
    {
      processEnv: cleanEnv(),
      attestedDatabaseCompatibility: "p006-restored",
      runPreflight: (_args, _env, options) => {
        preflightOptions = options;
        return { status: 0, stdout: "preflight ok\n", stderr: "" };
      },
      runCommand: (command) => calls.push(command),
      runBackup: successfulBackup(),
      runSmoke: () => ({ status: 0, stdout: "smoke ok\n", stderr: "" }),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(preflightOptions, {
    expectedDatabaseCompatibility: "p006-deadline-calendar-v1",
  });
  assert.equal(
    calls.some((command) =>
      command.includes("--prepare-quiesced-cutover"),
    ),
    true,
  );
});

test("production deploy fails after compose up when public smoke fails", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const envPath = join(tmpdir(), "charitypilot-smoke-fail-production.env");
  const calls = [];

  const result = runProductionComposeDeployFromArgs(
    ["--production-env-file", envPath, ...backupArgs],
    {
      processEnv: cleanEnv(),
      runPreflight: (args, env) => {
        calls.push({ type: "preflight", args, env });
        return { status: 0, stdout: "preflight ok\n", stderr: "" };
      },
      runCommand: (command, env) => {
        calls.push({ type: "command", command, env });
      },
      runBackup: successfulBackup(calls),
      runSmoke: (args, env) => {
        calls.push({ type: "smoke", args, env });
        return {
          status: 1,
          stdout: "",
          stderr: "keyed readiness must return 200 ready\n",
        };
      },
    },
  );

  assert.equal(result.status, 1);
  assert.deepEqual(
    calls.map((call) => call.type),
    [
      "preflight",
      "command",
      "command",
      "backup",
      "command",
      "command",
      "command",
      "command",
      "smoke",
      "command",
    ],
  );
  assert.match(result.stdout, /preflight ok/);
  assert.match(
    result.stderr,
    /Production compose deploy failed: post-deploy smoke failed/,
  );
  assert.match(result.stderr, /keyed readiness must return 200 ready/);
});

test("production deploy redacts command and smoke failure transcripts", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const envPath = join(tmpdir(), "charitypilot-redacted-production.env");
  const secret = "sk_live_deploySecret";

  const commandResult = runProductionComposeDeployFromArgs(
    ["--production-env-file", envPath, ...backupArgs],
    {
      processEnv: cleanEnv(),
      runPreflight: () => ({ status: 0, stdout: "preflight ok\n", stderr: "" }),
      runCommand: () => {
        throw new Error(
          `docker compose failed with STRIPE_SECRET_KEY=${secret} and DATABASE_URL=postgresql://user:pass@db.charitypilot.ie:5432/app`,
        );
      },
      runSmoke: () => ({ status: 0, stdout: "", stderr: "" }),
    },
  );

  assert.equal(commandResult.status, 1);
  assert.match(commandResult.stderr, /STRIPE_SECRET_KEY=\[redacted\]/);
  assert.match(commandResult.stderr, /DATABASE_URL=\[redacted\]/);
  assert.doesNotMatch(commandResult.stderr, /sk_live_deploySecret|user:pass/);

  const smokeResult = runProductionComposeDeployFromArgs(
    ["--production-env-file", envPath, ...backupArgs],
    {
      processEnv: cleanEnv(),
      runPreflight: () => ({ status: 0, stdout: "preflight ok\n", stderr: "" }),
      runCommand: () => {},
      runBackup: successfulBackup(),
      runSmoke: () => ({
        status: 1,
        stdout: "",
        stderr: `readiness failed with Bearer configured-service-role-key and ERROR_ALERT_WEBHOOK_URL=https://hooks.example/alert?token=secret-token\n`,
      }),
    },
  );

  assert.equal(smokeResult.status, 1);
  assert.match(smokeResult.stderr, /Bearer \[redacted\]/);
  assert.match(smokeResult.stderr, /ERROR_ALERT_WEBHOOK_URL=\[redacted\]/);
  assert.doesNotMatch(
    smokeResult.stderr,
    /configured-service-role-key|secret-token/,
  );
});

test("production deploy rejects invalid wait timeouts before preflight", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  let preflightCalled = false;

  const result = runProductionComposeDeployFromArgs(
    [
      "--production-env-file",
      ".env.production",
      ...backupArgs,
      "--wait-timeout",
      "0",
    ],
    {
      processEnv: cleanEnv(),
      runPreflight: () => {
        preflightCalled = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(result.status, 2);
  assert.equal(preflightCalled, false);
  assert.match(
    result.stderr,
    /--wait-timeout must be a positive integer number of seconds/,
  );
});

test("production deploy rejects empty production env file option before preflight", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  let preflightCalled = false;

  const result = runProductionComposeDeployFromArgs(
    ["--production-env-file=", ...backupArgs, "--dry-run"],
    {
      processEnv: cleanEnv(),
      runPreflight: () => {
        preflightCalled = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(result.status, 2);
  assert.equal(preflightCalled, false);
  assert.match(result.stderr, /Usage:/);
  assert.match(result.stderr, /--production-env-file requires a value/);
});

test("production deploy requires an explicit approved backup base before preflight", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  let preflightCalled = false;

  const result = runProductionComposeDeployFromArgs(
    ["--production-env-file", ".env.production"],
    {
      runPreflight: () => {
        preflightCalled = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(result.status, 2);
  assert.equal(preflightCalled, false);
  assert.match(
    result.stderr,
    /--backup-output-dir is required and must point to approved encrypted backup storage/,
  );

  const relativeResult = runProductionComposeDeployFromArgs([
    "--production-env-file",
    ".env.production",
    "--backup-output-dir",
    ".charitypilot-backups/cutover",
  ]);
  assert.equal(relativeResult.status, 2);
  assert.match(
    relativeResult.stderr,
    /must be an absolute path outside the repository/,
  );
});

test("production deploy fails before preflight when the host cutover lock is held", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  let preflightCalled = false;
  const result = runProductionComposeDeployFromArgs(
    ["--production-env-file", ".env.production", ...backupArgs],
    {
      processEnv: cleanEnv(),
      acquireCutoverLock: () => {
        throw new Error(
          "production cutover lock is already held by process 4242",
        );
      },
      runPreflight: () => {
        preflightCalled = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(preflightCalled, false);
  assert.match(result.stderr, /failed before preflight/);
  assert.match(result.stderr, /cutover lock is already held/);
});

test("production deploy can opt out of the TLS overlay when a managed load balancer terminates HTTPS", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const envPath = join(tmpdir(), "charitypilot-managed-lb-production.env");
  const calls = [];

  const result = runProductionComposeDeployFromArgs(
    ["--production-env-file", envPath, ...backupArgs, "--no-tls-proxy"],
    {
      processEnv: cleanEnv(),
      runPreflight: (args, env) => {
        calls.push({ type: "preflight", args, env });
        return { status: 0, stdout: "preflight ok\n", stderr: "" };
      },
      runCommand: (command, env) => {
        calls.push({ type: "command", command, env });
      },
      runBackup: successfulBackup(calls),
      runSmoke: (args, env) => {
        calls.push({ type: "smoke", args, env });
        return { status: 0, stdout: "smoke ok\n", stderr: "" };
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls[0].args, [
    "--production-env-file",
    envPath,
    "--no-tls-proxy",
  ]);
  assert.deepEqual(calls[7].command, [
    "docker",
    "compose",
    "--env-file",
    envPath,
    "-f",
    "compose.production.yml",
    "up",
    "--wait",
    "--wait-timeout",
    "180",
    "-d",
    "--remove-orphans",
  ]);
});

test("production deploy leaves the runtime stopped when backup verification fails", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const calls = [];

  const result = runProductionComposeDeployFromArgs(
    ["--production-env-file", "production.env", ...backupArgs],
    {
      processEnv: cleanEnv(),
      runPreflight: () => ({ status: 0, stdout: "preflight ok\n", stderr: "" }),
      runCommand: (command) => calls.push(command),
      runBackup: () => ({
        status: 1,
        stdout: "",
        stderr: "restore verification failed\n",
      }),
      runSmoke: () => {
        throw new Error("smoke must not run");
      },
    },
  );

  assert.equal(result.status, 1);
  assert.equal(
    calls.length,
    3,
    "pull, initial down, and fail-closed down must be the only compose calls",
  );
  assert.match(calls[1].join(" "), /down --remove-orphans$/);
  assert.deepEqual(calls[2], calls[1]);
  assert.doesNotMatch(
    calls.map((command) => command.join(" ")).join("\n"),
    /run --rm --no-deps migrate/,
  );
  assert.match(result.stderr, /production runtime remains stopped/);
});

test("production deploy stops a partially started promoted runtime when migration or startup fails", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const calls = [];

  const result = runProductionComposeDeployFromArgs(
    ["--production-env-file", "production.env", ...backupArgs],
    {
      processEnv: cleanEnv(),
      runPreflight: () => ({ status: 0, stdout: "", stderr: "" }),
      runCommand: (command) => {
        calls.push(command);
        if (command.includes("migrate") && command.includes("run"))
          throw new Error("migration failed");
      },
      runBackup: successfulBackup(),
    },
  );

  assert.equal(result.status, 1);
  assert.match(calls.at(-1).join(" "), /down --remove-orphans$/);
  assert.equal(
    calls.some((command) => command.includes("up")),
    false,
  );
  assert.match(
    result.stderr,
    /runtime remains stopped; recover by rolling forward/,
  );
});

test("production deploy fails closed when live migration history is incompatible before runtime start", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const calls = [];

  const result = runProductionComposeDeployFromArgs(
    ["--production-env-file", "production.env", ...backupArgs],
    {
      processEnv: cleanEnv(),
      runPreflight: () => ({ status: 0, stdout: "", stderr: "" }),
      runCommand: (command) => {
        calls.push(command);
        if (command.includes("status"))
          throw new Error("_prisma_migrations diverged");
      },
      runBackup: successfulBackup(),
      runSmoke: () => {
        throw new Error("smoke must not run");
      },
    },
  );

  assert.equal(result.status, 1);
  assert.equal(
    calls.some((command) => command.includes("up")),
    false,
  );
  assert.match(calls.at(-1).join(" "), /down --remove-orphans$/);
  assert.match(result.stderr, /_prisma_migrations diverged/);
  assert.match(result.stderr, /runtime remains stopped/);
});

test("backup protection helpers request owner-only directory and dump permissions", async () => {
  const { prepareProtectedBackupDirectory, protectBackupDump } =
    await loadDeployModule();
  const calls = [];

  prepareProtectedBackupDirectory("/secure/cutover", {
    mkdir: (path, options) => calls.push(["mkdir", path, options]),
    chmod: (path, mode) => calls.push(["chmod", path, mode]),
  });
  protectBackupDump("/secure/cutover", {
    exists: () => true,
    chmod: (path, mode) => calls.push(["chmod", path, mode]),
  });

  assert.deepEqual(calls, [
    ["mkdir", dirname("/secure/cutover"), { recursive: true, mode: 0o700 }],
    ["chmod", dirname("/secure/cutover"), 0o700],
    ["mkdir", "/secure/cutover", { recursive: false, mode: 0o700 }],
    ["chmod", "/secure/cutover", 0o700],
    ["chmod", join("/secure/cutover", "production-check.dump"), 0o600],
  ]);
});

test("protected backup child creation refuses to reuse an existing cutover directory", async () => {
  const { prepareProtectedBackupDirectory } = await loadDeployModule();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-protected-backup-test-"),
  );
  const child = join(tempDir, "cutover-fixed-id");
  try {
    prepareProtectedBackupDirectory(child);
    assert.throws(
      () => prepareProtectedBackupDirectory(child),
      (error) => error?.code === "EEXIST",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("each deployment writes into a unique child below the protected backup base", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const capturedBackupDirs = [];
  const ids = ["first-run", "second-run"];
  const dependencies = {
    processEnv: cleanEnv(),
    now: () => new Date("2026-07-10T21:00:00.000Z"),
    randomId: () => ids.shift(),
    runPreflight: () => ({ status: 0, stdout: "", stderr: "" }),
    runCommand: () => {},
    runBackup: (args) => {
      capturedBackupDirs.push(args[3]);
      return { status: 0, stdout: "", stderr: "" };
    },
    runSmoke: () => ({ status: 0, stdout: "", stderr: "" }),
  };

  const first = runProductionComposeDeployFromArgs(
    ["--production-env-file", "production.env", ...backupArgs],
    dependencies,
  );
  const second = runProductionComposeDeployFromArgs(
    ["--production-env-file", "production.env", ...backupArgs],
    dependencies,
  );

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(new Set(capturedBackupDirs).size, 2);
  assert.match(capturedBackupDirs[0], /first-run$/);
  assert.match(capturedBackupDirs[1], /second-run$/);
  assert.ok(
    capturedBackupDirs.every((path) =>
      path
        .replaceAll("\\", "/")
        .startsWith(backupOutputDir.replaceAll("\\", "/")),
    ),
  );
});

test("production deploy preserves its result and fails closed when lock release fails", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const result = runProductionComposeDeployFromArgs(
    ["--production-env-file", "production.env", ...backupArgs, "--dry-run"],
    {
      acquireCutoverLock: () => ({ testLock: true }),
      releaseCutoverLock: () => {
        throw new Error("lock ownership could not be proved");
      },
      runPreflight: () => ({
        status: 0,
        stdout: "preflight retained\n",
        stderr: "",
      }),
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Production compose deploy dry-run/);
  assert.match(result.stdout, /preflight retained/);
  assert.match(result.stderr, /could not release the host cutover lock/);
  assert.match(result.stderr, /lock ownership could not be proved/);
  assert.match(result.stderr, /do not start another deploy or rollback/);
});

test("nested production deploy rejects a lock whose persisted ownership changed", async () => {
  const runProductionComposeDeployFromArgs = await loadDeployRunner();
  const lockModule = await import(
    pathToFileURL(join(scriptsDir, "production-cutover-lock.mjs")).href
  );
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-nested-cutover-lock-test-"),
  );
  const lockPath = join(tempDir, "cutover.lock");
  let preflightCalled = false;

  try {
    const lock = lockModule.acquireProductionCutoverLock({
      lockPath,
      token: "original-owner",
    });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 9999, token: "replacement-owner" }),
    );
    const result = runProductionComposeDeployFromArgs(
      ["--production-env-file", "production.env", ...backupArgs, "--dry-run"],
      {
        cutoverLock: lock,
        runPreflight: () => {
          preflightCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(preflightCalled, false);
    assert.match(
      result.stderr,
      /production cutover lock ownership changed while the cutover was running/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
