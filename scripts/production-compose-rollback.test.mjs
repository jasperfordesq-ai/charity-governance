import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rollbackScriptPath = join(scriptsDir, "production-compose-rollback.mjs");
const currentDigest = "b".repeat(64);
const rollbackDigest = "a".repeat(64);
const productionSupabaseUrl = "https://xjvdkmqbtczrnlqpswfa.supabase.co";
const backupOutputDir = join(
  tmpdir(),
  "charitypilot-approved-encrypted-rollback-cutover",
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

async function loadRollbackRunner() {
  assert.ok(
    existsSync(rollbackScriptPath),
    "production compose rollback script must exist",
  );
  const module = await import(pathToFileURL(rollbackScriptPath).href);
  assert.equal(typeof module.runProductionComposeRollbackFromArgs, "function");
  return (args, dependencies = {}) =>
    module.runProductionComposeRollbackFromArgs(args, {
      cutoverLockPath: join(
        tmpdir(),
        `charitypilot-rollback-test-${process.pid}.lock`,
      ),
      ...dependencies,
    });
}

function productionEnv(overrides = {}) {
  const values = {
    NODE_ENV: "production",
    PORT: "3002",
    TRUSTED_PROXY_ADDRESSES: "10.0.0.10",
    READINESS_API_KEY: "r7Nq2Xc9Lm4Pz8Va6Ys3Td5He1Bw0UkF",
    DATABASE_URL:
      "postgresql://user:pass@db.charitypilot.ie:5432/charitypilot?sslmode=require",
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
    CHARITYPILOT_API_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${currentDigest}`,
    CHARITYPILOT_WEB_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${currentDigest}`,
    CHARITYPILOT_MIGRATION_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${currentDigest}`,
    CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL: "https://api.charitypilot.ie",
    ...overrides,
  };

  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function rollbackManifest(overrides = {}) {
  const values = {
    CHARITYPILOT_API_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-api@sha256:${rollbackDigest}`,
    CHARITYPILOT_WEB_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-web@sha256:${rollbackDigest}`,
    CHARITYPILOT_MIGRATION_IMAGE: `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${rollbackDigest}`,
    CHARITYPILOT_DATABASE_COMPATIBILITY: "p006-deadline-calendar-v1",
    CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL: "https://api.charitypilot.ie",
    ...overrides,
  };

  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function schemaCompatibilityAttestation(
  rollbackDigestManifest,
  manifestContent,
  overrides = {},
) {
  return JSON.stringify({
    kind: "charitypilot-schema-compatibility-attestation",
    schemaVersion: 1,
    environment: "production",
    databaseCompatibility: "p006-deadline-calendar-v1",
    assessedAt: "2026-07-10T20:00:00.000Z",
    rollbackDigestManifest,
    rollbackDigestManifestSha256: sha256(manifestContent),
    evidenceReference: "change://CHG-2026-0710/schema-compatibility",
    operator: "operations-owner",
    acknowledgement:
      "I confirm the selected application images are compatible with the live P0-06 database schema and migration history.",
    ...overrides,
  });
}

function databaseRestoreAttestation(
  rollbackDigestManifest,
  manifestContent,
  restoredBackupContent,
  overrides = {},
) {
  return JSON.stringify({
    kind: "charitypilot-database-restore-attestation",
    schemaVersion: 1,
    environment: "production",
    databaseRestoreCompleted: true,
    runtimeStoppedDuringRestore: true,
    backupCapturedBeforeIncompatibleMigration: true,
    databaseRestoreCompletedAt: "2026-07-10T20:00:00.000Z",
    backupReference: "encrypted-backup://operations/p006-pre-migration",
    restoreEvidenceReference: "incident://INC-2026-0710/restore-checks",
    operator: "operations-owner",
    rollbackDigestManifest,
    rollbackDigestManifestSha256: sha256(manifestContent),
    restoredBackupSha256: sha256(restoredBackupContent),
    acknowledgement:
      "I confirm the production runtime was stopped and the database was restored from a backup captured before the incompatible migration.",
    ...overrides,
  });
}

function writeSchemaCompatibilityAttestation(
  tempDir,
  manifestPath,
  overrides = {},
) {
  const attestationPath = join(
    tempDir,
    "schema-compatibility-attestation.json",
  );
  writeFileSync(
    attestationPath,
    schemaCompatibilityAttestation(
      "release-image-digests.previous.env",
      readFileSync(manifestPath),
      overrides,
    ),
  );
  return attestationPath;
}

test("production rollback dry-run tolerates legacy Supabase metadata and delegates with rollback digests", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-dry-run-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  const deployCalls = [];

  writeFileSync(envPath, productionEnv());
  writeFileSync(manifestPath, rollbackManifest({
    CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL: productionSupabaseUrl,
  }));
  const schemaAttestationPath = writeSchemaCompatibilityAttestation(
    tempDir,
    manifestPath,
  );

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--schema-compatibility-attestation-file",
        schemaAttestationPath,
        ...backupArgs,
        "--wait-timeout",
        "240",
        "--dry-run",
      ],
      {
        processEnv: cleanEnv(),
        now: () => new Date("2026-07-10T20:05:00.000Z"),
        runDeploy: (args, env) => {
          deployCalls.push({
            args,
            env,
            mergedEnvPath: args[1],
            mergedEnv: readFileSync(args[1], "utf8"),
          });
          return { status: 0, stdout: "deploy dry-run ok\n", stderr: "" };
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(deployCalls.length, 1);
    assert.equal(deployCalls[0].env.processEnv.PATH, cleanEnv().PATH);
    assert.ok(
      deployCalls[0].env.cutoverLock,
      "rollback must pass its held lock reentrantly into deploy",
    );
    assert.deepEqual(deployCalls[0].args, [
      "--production-env-file",
      deployCalls[0].mergedEnvPath,
      "--wait-timeout",
      "240",
      "--backup-output-dir",
      backupOutputDir,
      "--dry-run",
    ]);
    assert.match(
      deployCalls[0].mergedEnv,
      new RegExp(
        `CHARITYPILOT_API_IMAGE=ghcr\\.io/jasperfordesq-ai/charity-governance-api@sha256:${rollbackDigest}`,
      ),
    );
    assert.match(
      deployCalls[0].mergedEnv,
      new RegExp(
        `CHARITYPILOT_WEB_IMAGE=ghcr\\.io/jasperfordesq-ai/charity-governance-web@sha256:${rollbackDigest}`,
      ),
    );
    assert.match(
      deployCalls[0].mergedEnv,
      new RegExp(
        `CHARITYPILOT_MIGRATION_IMAGE=ghcr\\.io/jasperfordesq-ai/charity-governance-migrations@sha256:${rollbackDigest}`,
      ),
    );
    assert.match(
      deployCalls[0].mergedEnv,
      /CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL=https:\/\/api\.charitypilot\.ie/,
    );
    assert.doesNotMatch(
      deployCalls[0].mergedEnv,
      /CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_SUPABASE_URL=https:\/\/xjvdkmqbtczrnlqpswfa\.supabase\.co/,
    );
    assert.match(
      deployCalls[0].mergedEnv,
      /CHARITYPILOT_DATABASE_COMPATIBILITY=p006-deadline-calendar-v1/,
    );
    assert.match(
      deployCalls[0].mergedEnv,
      /JWT_SECRET=J9mQ4vRx7tL2pZs6NfB8hDy3WcK1uEa5/,
    );
    assert.match(deployCalls[0].mergedEnv, new RegExp(currentDigest));
    assert.ok(
      deployCalls[0].mergedEnv.lastIndexOf(rollbackDigest) >
        deployCalls[0].mergedEnv.lastIndexOf(currentDigest),
      "trusted rollback overrides must be appended after the byte-preserved production env",
    );
    assert.match(result.stdout, /Production compose rollback dry-run/);
    assert.match(
      result.stdout,
      /Image rollback authorised by a fresh, manifest-bound schema compatibility attestation/,
    );
    assert.match(result.stdout, /deploy dry-run ok/);
    assert.equal(
      existsSync(deployCalls[0].mergedEnvPath),
      false,
      "temporary merged env file must be removed",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback preserves quoted and special-character production env bytes exactly", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-env-fidelity-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  const specialLine = "JWT_SECRET='literal $dollar # hash \\ slash and spaces'";
  const originalContent = productionEnv()
    .replace(
      /JWT_SECRET=.*\n/,
      `${specialLine}\n# preserve this operator comment byte-for-byte\n`,
    )
    .trimEnd();
  writeFileSync(envPath, originalContent);
  writeFileSync(manifestPath, rollbackManifest());
  const schemaAttestationPath = writeSchemaCompatibilityAttestation(
    tempDir,
    manifestPath,
  );
  let mergedContent = "";

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--schema-compatibility-attestation-file",
        schemaAttestationPath,
        ...backupArgs,
        "--dry-run",
      ],
      {
        processEnv: cleanEnv(),
        now: () => new Date("2026-07-10T20:05:00.000Z"),
        runDeploy: (args) => {
          mergedContent = readFileSync(args[1], "utf8");
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.ok(mergedContent.startsWith(`${originalContent}\n`));
    assert.match(
      mergedContent,
      /JWT_SECRET='literal \$dollar # hash \\ slash and spaces'/,
    );
    assert.match(
      mergedContent,
      /# preserve this operator comment byte-for-byte/,
    );
    assert.ok(
      mergedContent.lastIndexOf(rollbackDigest) >
        mergedContent.lastIndexOf(currentDigest),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback fails before deploy when rollback digest manifest uses mutable image tags", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-invalid-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  let deployCalled = false;

  writeFileSync(envPath, productionEnv());
  writeFileSync(
    manifestPath,
    rollbackManifest({
      CHARITYPILOT_API_IMAGE:
        "ghcr.io/jasperfordesq-ai/charity-governance-api:sha-old",
    }),
  );

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        ...backupArgs,
      ],
      {
        processEnv: cleanEnv(),
        runDeploy: () => {
          deployCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(deployCalled, false);
    assert.match(result.stderr, /Production compose rollback failed/);
    assert.match(
      result.stderr,
      /CHARITYPILOT_API_IMAGE must be pinned to an immutable sha256 digest/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback requires web image build origin metadata in the rollback manifest", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-missing-origin-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  let deployCalled = false;

  writeFileSync(envPath, productionEnv());
  writeFileSync(
    manifestPath,
    rollbackManifest({
      CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL: "",
    }),
  );

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        ...backupArgs,
      ],
      {
        processEnv: cleanEnv(),
        runDeploy: () => {
          deployCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(deployCalled, false);
    assert.match(
      result.stderr,
      /CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL is required in the rollback digest manifest/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback propagates deploy failures from the shared deploy path", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-deploy-fail-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");

  writeFileSync(envPath, productionEnv());
  writeFileSync(manifestPath, rollbackManifest());
  const schemaAttestationPath = writeSchemaCompatibilityAttestation(
    tempDir,
    manifestPath,
  );

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--schema-compatibility-attestation-file",
        schemaAttestationPath,
        ...backupArgs,
      ],
      {
        processEnv: cleanEnv(),
        now: () => new Date("2026-07-10T20:05:00.000Z"),
        runDeploy: () => ({
          status: 1,
          stdout: "preflight ok\n",
          stderr: "post-deploy smoke failed\n",
        }),
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /preflight ok/);
    assert.match(
      result.stderr,
      /Production compose rollback failed: deployment failed/,
    );
    assert.match(result.stderr, /post-deploy smoke failed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rollback cleanup failure guidance uses the durable production env after temporary env deletion", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-cleanup-guidance-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  writeFileSync(envPath, productionEnv());
  writeFileSync(manifestPath, rollbackManifest());
  const schemaAttestationPath = writeSchemaCompatibilityAttestation(
    tempDir,
    manifestPath,
  );
  let temporaryMergedEnvPath = "";

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--schema-compatibility-attestation-file",
        schemaAttestationPath,
        ...backupArgs,
      ],
      {
        processEnv: cleanEnv(),
        now: () => new Date("2026-07-10T20:05:00.000Z"),
        runDeploy: (args) => {
          temporaryMergedEnvPath = args[1];
          return {
            status: 1,
            stdout: "",
            stderr:
              `Fail-closed runtime cleanup also failed: docker error\n` +
              `Run this command before any recovery action: docker compose --env-file ${temporaryMergedEnvPath} -f compose.production.yml down --remove-orphans\n`,
          };
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(existsSync(temporaryMergedEnvPath), false);
    assert.doesNotMatch(
      result.stderr,
      new RegExp(temporaryMergedEnvPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(
      result.stderr,
      /Rollback fail-closed cleanup needs operator action using the durable production env/,
    );
    assert.match(
      result.stderr,
      /--profile maintenance --profile jobs down --remove-orphans/,
    );
    assert.match(
      result.stderr,
      new RegExp(envPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback redacts deployment failure transcripts", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-redacted-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");

  writeFileSync(envPath, productionEnv());
  writeFileSync(manifestPath, rollbackManifest());
  const schemaAttestationPath = writeSchemaCompatibilityAttestation(
    tempDir,
    manifestPath,
  );

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--schema-compatibility-attestation-file",
        schemaAttestationPath,
        ...backupArgs,
      ],
      {
        processEnv: cleanEnv(),
        now: () => new Date("2026-07-10T20:05:00.000Z"),
        runDeploy: () => ({
          status: 1,
          stdout: "preflight ok\n",
          stderr:
            "rollback smoke failed with JWT_SECRET=super-secret-jwt and STRIPE_WEBHOOK_SECRET=whsec_rollbackSecret\n",
        }),
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /JWT_SECRET=\[redacted\]/);
    assert.match(result.stderr, /STRIPE_WEBHOOK_SECRET=\[redacted\]/);
    assert.doesNotMatch(result.stderr, /super-secret-jwt|whsec_rollbackSecret/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback redacts thrown deploy exceptions", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-throw-redacted-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  let mergedEnvPath = null;

  writeFileSync(envPath, productionEnv());
  writeFileSync(manifestPath, rollbackManifest());
  const schemaAttestationPath = writeSchemaCompatibilityAttestation(
    tempDir,
    manifestPath,
  );

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--schema-compatibility-attestation-file",
        schemaAttestationPath,
        ...backupArgs,
      ],
      {
        processEnv: cleanEnv(),
        now: () => new Date("2026-07-10T20:05:00.000Z"),
        runDeploy: (args) => {
          mergedEnvPath = args[1];
          throw new Error(
            "rollback crashed with DATABASE_URL=postgresql://user:pass@db.charitypilot.example:5432/charitypilot?sslmode=require and Bearer sk_live_configuredSecret&token=secret-token",
          );
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Production compose rollback failed:/);
    assert.match(result.stderr, /DATABASE_URL=\[redacted\]/);
    assert.match(result.stderr, /Bearer \[redacted-stripe-key\]/);
    assert.match(result.stderr, /token=\[redacted\]/);
    assert.doesNotMatch(
      result.stderr,
      /user:pass|postgresql:\/\/|sk_live_configuredSecret|secret-token/,
    );
    assert.equal(
      existsSync(mergedEnvPath),
      false,
      "temporary merged env file must be removed after throw",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback requires an explicit rollback digest manifest", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();

  const result = runProductionComposeRollbackFromArgs(
    ["--production-env-file", ".env.production"],
    { processEnv: cleanEnv() },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--rollback-digest-file is required/);
});

test("production rollback rejects empty path options before deploy", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  let deployCalled = false;

  const emptyEnvResult = runProductionComposeRollbackFromArgs(
    [
      "--production-env-file=",
      "--rollback-digest-file",
      "release-image-digests.previous.env",
    ],
    {
      processEnv: cleanEnv(),
      runDeploy: () => {
        deployCalled = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(emptyEnvResult.status, 2);
  assert.equal(deployCalled, false);
  assert.match(emptyEnvResult.stderr, /Usage:/);
  assert.match(emptyEnvResult.stderr, /--production-env-file requires a value/);

  const emptyDigestResult = runProductionComposeRollbackFromArgs(
    ["--production-env-file", ".env.production", "--rollback-digest-file="],
    {
      processEnv: cleanEnv(),
      runDeploy: () => {
        deployCalled = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );

  assert.equal(emptyDigestResult.status, 2);
  assert.equal(deployCalled, false);
  assert.match(emptyDigestResult.stderr, /Usage:/);
  assert.match(
    emptyDigestResult.stderr,
    /--rollback-digest-file requires a value/,
  );
});

test("production rollback can opt out of the TLS overlay when deploy uses managed load-balancer TLS", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-no-tls-proxy-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  const deployCalls = [];

  writeFileSync(envPath, productionEnv());
  writeFileSync(manifestPath, rollbackManifest());
  const schemaAttestationPath = writeSchemaCompatibilityAttestation(
    tempDir,
    manifestPath,
  );

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--schema-compatibility-attestation-file",
        schemaAttestationPath,
        ...backupArgs,
        "--no-tls-proxy",
      ],
      {
        processEnv: cleanEnv(),
        now: () => new Date("2026-07-10T20:05:00.000Z"),
        runDeploy: (args, env) => {
          deployCalls.push({ args, env });
          return { status: 0, stdout: "deploy ok\n", stderr: "" };
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(deployCalls.length, 1);
    assert.deepEqual(deployCalls[0].args, [
      "--production-env-file",
      deployCalls[0].args[1],
      "--backup-output-dir",
      backupOutputDir,
      "--no-tls-proxy",
    ]);
    assert.match(result.stdout, /Production compose rollback/);
    assert.match(result.stdout, /deploy ok/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback refuses a legacy image manifest without a pre-migration database restore attestation", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-incompatible-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  let deployCalled = false;

  writeFileSync(envPath, productionEnv());
  writeFileSync(
    manifestPath,
    rollbackManifest({ CHARITYPILOT_DATABASE_COMPATIBILITY: "" }),
  );

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        ...backupArgs,
      ],
      {
        processEnv: cleanEnv(),
        runDeploy: () => {
          deployCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(deployCalled, false);
    assert.match(result.stderr, /image-only rollback is forbidden/);
    assert.match(
      result.stderr,
      /restore the production database from a backup captured before the incompatible migration/,
    );
    assert.match(result.stderr, /--database-restore-attestation-file/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback permits a legacy manifest only after validating explicit restore evidence", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-restored-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  const attestationPath = join(tempDir, "database-restore-attestation.json");
  const restoredBackupPath = join(tempDir, "pre-p006-production.dump");
  const restoredBackupContent =
    "representative pre-p006 custom-format backup bytes";
  const deployCalls = [];

  writeFileSync(envPath, productionEnv());
  writeFileSync(
    manifestPath,
    rollbackManifest({ CHARITYPILOT_DATABASE_COMPATIBILITY: "" }),
  );
  writeFileSync(restoredBackupPath, restoredBackupContent);
  writeFileSync(
    attestationPath,
    databaseRestoreAttestation(
      "release-image-digests.previous.env",
      readFileSync(manifestPath),
      restoredBackupContent,
    ),
  );

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--database-restore-attestation-file",
        attestationPath,
        "--restored-backup-file",
        restoredBackupPath,
        "--backup-output-dir",
        backupOutputDir,
        "--dry-run",
      ],
      {
        processEnv: cleanEnv(),
        now: () => new Date("2026-07-10T20:05:00.000Z"),
        runDeploy: (args, dependencies) => {
          deployCalls.push({
            args,
            dependencies,
            mergedEnv: readFileSync(args[1], "utf8"),
          });
          return { status: 0, stdout: "deploy dry-run ok\n", stderr: "" };
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(deployCalls.length, 1);
    assert.equal(
      deployCalls[0].dependencies.attestedDatabaseCompatibility,
      "pre-p006-restored",
    );
    assert.match(
      deployCalls[0].mergedEnv,
      /CHARITYPILOT_DATABASE_COMPATIBILITY=pre-p006-restored/,
    );
    assert.deepEqual(deployCalls[0].args.slice(2), [
      "--backup-output-dir",
      backupOutputDir,
      "--dry-run",
    ]);
    assert.match(
      result.stdout,
      /Cross-boundary rollback authorised by a fresh exact-manifest-and-backup-hash-bound database restore attestation/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback rejects incomplete or mismatched database restore attestations", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-bad-attestation-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  const attestationPath = join(tempDir, "database-restore-attestation.json");
  const restoredBackupPath = join(tempDir, "pre-p006-production.dump");
  const restoredBackupContent =
    "representative pre-p006 custom-format backup bytes";
  let deployCalled = false;

  writeFileSync(envPath, productionEnv());
  writeFileSync(
    manifestPath,
    rollbackManifest({ CHARITYPILOT_DATABASE_COMPATIBILITY: "" }),
  );
  writeFileSync(restoredBackupPath, restoredBackupContent);
  writeFileSync(
    attestationPath,
    databaseRestoreAttestation(
      "different-manifest.env",
      readFileSync(manifestPath),
      restoredBackupContent,
      { runtimeStoppedDuringRestore: false },
    ),
  );

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--database-restore-attestation-file",
        attestationPath,
        "--restored-backup-file",
        restoredBackupPath,
        ...backupArgs,
      ],
      {
        processEnv: cleanEnv(),
        now: () => new Date("2026-07-10T20:05:00.000Z"),
        runDeploy: () => {
          deployCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );

    assert.equal(result.status, 1);
    assert.equal(deployCalled, false);
    assert.match(
      result.stderr,
      /database restore attestation failed validation/,
    );
    assert.match(result.stderr, /runtimeStoppedDuringRestore must be true/);
    assert.match(
      result.stderr,
      /rollbackDigestManifest must equal release-image-digests\.previous\.env/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback rejects a same-marker manifest without an explicit compatibility attestation", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-no-schema-attestation-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  writeFileSync(envPath, productionEnv());
  writeFileSync(manifestPath, rollbackManifest());

  try {
    const result = runProductionComposeRollbackFromArgs([
      "--production-env-file",
      envPath,
      "--rollback-digest-file",
      manifestPath,
      ...backupArgs,
    ]);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /image-only rollback requires --schema-compatibility-attestation-file/,
    );
    assert.match(result.stderr, /is necessary but is not trusted by itself/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback rejects stale and manifest-tampered compatibility attestations", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(
      tmpdir(),
      "charitypilot-production-rollback-stale-schema-attestation-",
    ),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  writeFileSync(envPath, productionEnv());
  writeFileSync(manifestPath, rollbackManifest());
  const stalePath = writeSchemaCompatibilityAttestation(tempDir, manifestPath, {
    assessedAt: "2026-07-10T19:00:00.000Z",
  });

  try {
    const staleResult = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--schema-compatibility-attestation-file",
        stalePath,
        ...backupArgs,
      ],
      { now: () => new Date("2026-07-10T20:05:00.000Z") },
    );
    assert.equal(staleResult.status, 1);
    assert.match(
      staleResult.stderr,
      /assessedAt must be no more than 30 minutes old/,
    );

    const futurePath = writeSchemaCompatibilityAttestation(
      tempDir,
      manifestPath,
      {
        assessedAt: "2026-07-10T20:20:00.000Z",
      },
    );
    const futureResult = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--schema-compatibility-attestation-file",
        futurePath,
        ...backupArgs,
      ],
      { now: () => new Date("2026-07-10T20:05:00.000Z") },
    );
    assert.equal(futureResult.status, 1);
    assert.match(futureResult.stderr, /assessedAt must not be in the future/);

    const freshPath = writeSchemaCompatibilityAttestation(
      tempDir,
      manifestPath,
    );
    writeFileSync(
      manifestPath,
      `${readFileSync(manifestPath, "utf8")}# tampered after attestation\n`,
    );
    const tamperedResult = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--schema-compatibility-attestation-file",
        freshPath,
        ...backupArgs,
      ],
      { now: () => new Date("2026-07-10T20:05:00.000Z") },
    );
    assert.equal(tamperedResult.status, 1);
    assert.match(
      tamperedResult.stderr,
      /rollbackDigestManifestSha256 does not match the exact rollback digest manifest bytes/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback rejects a restore attestation when the restored backup bytes are tampered", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-tampered-backup-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  const attestationPath = join(tempDir, "database-restore-attestation.json");
  const restoredBackupPath = join(tempDir, "pre-p006-production.dump");
  const originalBackup = "original restored backup bytes";
  writeFileSync(envPath, productionEnv());
  writeFileSync(
    manifestPath,
    rollbackManifest({ CHARITYPILOT_DATABASE_COMPATIBILITY: "" }),
  );
  writeFileSync(restoredBackupPath, originalBackup);
  writeFileSync(
    attestationPath,
    databaseRestoreAttestation(
      "release-image-digests.previous.env",
      readFileSync(manifestPath),
      originalBackup,
    ),
  );
  writeFileSync(restoredBackupPath, `${originalBackup}-tampered`);

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--database-restore-attestation-file",
        attestationPath,
        "--restored-backup-file",
        restoredBackupPath,
        ...backupArgs,
      ],
      { now: () => new Date("2026-07-10T20:05:00.000Z") },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /restoredBackupSha256 does not match the exact restored backup bytes/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback requires and forwards the protected backup base on success paths", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const missing = runProductionComposeRollbackFromArgs([
    "--production-env-file",
    ".env.production",
    "--rollback-digest-file",
    "release-image-digests.previous.env",
  ]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--backup-output-dir is required/);
});

test("compatible rollback dry-run integrates with the real deploy parser and forwards every safety flag", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-real-deploy-parser-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  writeFileSync(envPath, productionEnv());
  writeFileSync(manifestPath, rollbackManifest());
  const attestationPath = writeSchemaCompatibilityAttestation(
    tempDir,
    manifestPath,
  );

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--schema-compatibility-attestation-file",
        attestationPath,
        ...backupArgs,
        "--no-tls-proxy",
        "--dry-run",
      ],
      {
        processEnv: cleanEnv(),
        now: () => new Date("2026-07-10T20:05:00.000Z"),
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production compose deploy dry-run/);
    assert.match(
      result.stdout,
      /--backup-output-dir "<approved-backup-dir>" --keep-backup/,
    );
    assert.match(
      result.stdout,
      /migrate migrate status --schema prisma\/schema\.prisma/,
    );
    assert.match(result.stdout, /Production compose rollback completed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("production rollback preserves its result and fails closed when lock release fails", async () => {
  const runProductionComposeRollbackFromArgs = await loadRollbackRunner();
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-production-rollback-lock-release-"),
  );
  const envPath = join(tempDir, "production.env");
  const manifestPath = join(tempDir, "release-image-digests.previous.env");
  writeFileSync(envPath, productionEnv());
  writeFileSync(manifestPath, rollbackManifest());
  const attestationPath = writeSchemaCompatibilityAttestation(
    tempDir,
    manifestPath,
  );

  try {
    const result = runProductionComposeRollbackFromArgs(
      [
        "--production-env-file",
        envPath,
        "--rollback-digest-file",
        manifestPath,
        "--schema-compatibility-attestation-file",
        attestationPath,
        ...backupArgs,
        "--dry-run",
      ],
      {
        now: () => new Date("2026-07-10T20:05:00.000Z"),
        acquireCutoverLock: () => ({ testLock: true }),
        releaseCutoverLock: () => {
          throw new Error("lock file disappeared before release");
        },
        runDeploy: () => ({
          status: 0,
          stdout: "delegated deploy retained\n",
          stderr: "",
        }),
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /delegated deploy retained/);
    assert.match(result.stdout, /Production compose rollback completed/);
    assert.match(result.stderr, /could not release the host cutover lock/);
    assert.match(result.stderr, /lock file disappeared before release/);
    assert.match(result.stderr, /do not start another deploy or rollback/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
