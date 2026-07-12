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
import { basename, join } from "node:path";
import { test } from "node:test";

import {
  P107A_RECOVERY_ACKNOWLEDGEMENT,
  P107A_RECOVERY_CHECKSUM_OUTPUT_PREFIX,
  P107A_RECOVERY_IMAGE_CHECKSUM_SCRIPT,
  P107A_RECOVERY_MIGRATION,
  P107A_RECOVERY_MIGRATIONS,
  P107A_RECOVERY_PREFLIGHT_SQL,
  assertP107ARecoveryPreflightTerminalAssertion,
  buildP107ARecoveryPreflightSql,
  parseP107AMigrationChecksumOutput,
  runProductionP107ARecoveryFromArgs,
} from "./production-recover-p107a-migration.mjs";
import {
  acquireProductionCutoverLock,
  assertProductionCutoverLock,
  releaseProductionCutoverLock,
} from "./production-cutover-lock.mjs";

const NOW = new Date("2026-07-11T22:00:00.000Z");
const MIGRATION_IMAGE =
  `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${"a".repeat(64)}`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const SELECTED_IMAGE_CHECKSUMS = Object.fromEntries(
  P107A_RECOVERY_MIGRATIONS.map((migration) => [
    migration,
    sha256(Buffer.from(`selected-image:${migration}`)),
  ]),
);

function productionEnv() {
  return [
    "NODE_ENV=production",
    `CHARITYPILOT_MIGRATION_IMAGE=${MIGRATION_IMAGE}`,
    "CHARITYPILOT_DATABASE_COMPATIBILITY=p107a-password-recovery-v1",
    "DATABASE_URL=postgresql://operator:secret@db.charitypilot.ie:5432/charitypilot?sslmode=verify-full",
    "",
  ].join("\n");
}

function checksumManifestOutput(overrides = {}) {
  return `${P107A_RECOVERY_CHECKSUM_OUTPUT_PREFIX}${JSON.stringify({
    schemaVersion: 1,
    migrations: { ...SELECTED_IMAGE_CHECKSUMS, ...overrides },
  })}\n`;
}

function successfulRunCommand(command) {
  if (command.includes(P107A_RECOVERY_IMAGE_CHECKSUM_SCRIPT)) {
    return { status: 0, stdout: checksumManifestOutput(), stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
}

function recoveryAttestation(envPath, envBytes, overrides = {}) {
  return JSON.stringify({
    kind: "charitypilot-p107a-failed-migration-recovery-attestation",
    schemaVersion: 1,
    environment: "production",
    migrationName: P107A_RECOVERY_MIGRATION,
    assessedAt: "2026-07-11T21:50:00.000Z",
    productionEnvFile: basename(envPath),
    productionEnvSha256: sha256(envBytes),
    migrationImage: MIGRATION_IMAGE,
    operator: "named-operations-owner",
    evidenceReference: "incident://INC-2026-0711/p107a-recovery",
    runtimeQuiesced: true,
    failedMigrationTransactionRolledBack: true,
    targetCatalogRollbackVerified: true,
    remediationOrUnexpectedWriterResolutionCompleted: true,
    acknowledgement: P107A_RECOVERY_ACKNOWLEDGEMENT,
    ...overrides,
  });
}

function fixture(overrides = {}) {
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-p107a-production-recovery-test-"),
  );
  const envPath = join(tempDir, "production.env");
  const attestationPath = join(tempDir, "recovery-attestation.json");
  const lockPath = join(tempDir, "cutover.lock");
  const backupOutputDir = join(
    tmpdir(),
    `charitypilot-p107a-recovery-backups-${process.pid}-${Date.now()}`,
  );
  const envBytes = Buffer.from(overrides.envContent ?? productionEnv());
  writeFileSync(envPath, envBytes);
  writeFileSync(
    attestationPath,
    recoveryAttestation(
      envPath,
      envBytes,
      overrides.attestationOverrides ?? {},
    ),
  );
  return {
    tempDir,
    envPath,
    attestationPath,
    lockPath,
    backupOutputDir,
    args: [
      "--production-env-file",
      envPath,
      "--backup-output-dir",
      backupOutputDir,
      "--recovery-attestation-file",
      attestationPath,
    ],
  };
}

function dependencies(overrides = {}) {
  return {
    now: () => NOW,
    runPreflight: () => ({
      status: 0,
      stdout: "standard preflight ok\n",
      stderr: "",
    }),
    runCommand: successfulRunCommand,
    runDeploy: () => ({
      status: 0,
      stdout: "delegated deploy backup migration status reconciliation startup smoke ok\n",
      stderr: "",
    }),
    ...overrides,
  };
}

function cleanFixture(value) {
  rmSync(value.tempDir, { recursive: true, force: true });
}

test("production runbook carries the exact fail-closed P1-07A recovery acknowledgement", () => {
  const runbook = readFileSync(
    new URL("../docs/production-runbook.md", import.meta.url),
    "utf8",
  );
  assert.ok(
    runbook.includes(P107A_RECOVERY_ACKNOWLEDGEMENT),
    "the operator copy/paste acknowledgement must stay byte-for-byte aligned with the recovery script",
  );
});

test("P1-07A recovery SQL is terminal read-only and binds exact history, catalog, active blockers, and deterministic inactive cleanup", () => {
  assert.match(
    P107A_RECOVERY_PREFLIGHT_SQL,
    /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;/,
  );
  assert.match(P107A_RECOVERY_PREFLIGHT_SQL, /SET LOCAL statement_timeout = '30s'/);
  assert.match(P107A_RECOVERY_PREFLIGHT_SQL, /SET LOCAL lock_timeout = '5s'/);
  assert.doesNotMatch(P107A_RECOVERY_PREFLIGHT_SQL, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(P107A_RECOVERY_PREFLIGHT_SQL, /\b(?:COMMIT|ROLLBACK)\s*;/i);
  assert.match(P107A_RECOVERY_PREFLIGHT_SQL, /applied_predecessor_rows <> 20/);
  assert.match(P107A_RECOVERY_PREFLIGHT_SQL, /total_history_rows <> 21/);
  assert.match(P107A_RECOVERY_PREFLIGHT_SQL, /checksum_mismatch_rows <> 0/);
  assert.match(P107A_RECOVERY_PREFLIGHT_SQL, /target_table_rows <> 0/);
  assert.match(P107A_RECOVERY_PREFLIGHT_SQL, /target_type_rows <> 0/);
  assert.match(P107A_RECOVERY_PREFLIGHT_SQL, /target_function_rows <> 0/);
  assert.match(P107A_RECOVERY_PREFLIGHT_SQL, /target_trigger_rows <> 0/);
  for (const targetResidueArtifact of [
    'AuthRecoveryRetiredSecret',
    'guard_auth_recovery_retired_secret',
    'reject_auth_recovery_retired_secret_truncate',
    'guard_auth_recovery_control',
    'guard_retired_user_password_recovery_slot',
    'AuthRecoveryRetiredSecret_guard_integrity',
    'AuthRecoveryRetiredSecret_reject_truncate',
    'AuthRecoveryControl_guard_integrity',
    'User_guard_retired_password_recovery_slot',
  ]) {
    assert.match(P107A_RECOVERY_PREFLIGHT_SQL, new RegExp(targetResidueArtifact));
  }
  for (const blocker of [
    "half_pair_count",
    "malformed_hash_count",
    "unsafe_future_expiry_count",
    "overlong_active_email_count",
  ]) {
    assert.match(P107A_RECOVERY_PREFLIGHT_SQL, new RegExp(`${blocker} > 0`));
  }
  assert.match(P107A_RECOVERY_PREFLIGHT_SQL, /inactive_principal_cleanup_rows/);
  assert.match(
    P107A_RECOVERY_PREFLIGHT_SQL,
    /WHERE \(account\."resetToken" IS NOT NULL OR account\."resetTokenExpiry" IS NOT NULL\)/,
  );
  const blockerIf = P107A_RECOVERY_PREFLIGHT_SQL.match(
    /IF half_pair_count > 0[\s\S]*?THEN/,
  )?.[0] ?? "";
  assert.doesNotMatch(blockerIf, /inactive_principal_cleanup_rows > 0/);
  assert.match(P107A_RECOVERY_PREFLIGHT_SQL, /\$p107a_recovery\$;$/);
});

test("selected image checksum manifest binds exactly all 21 P1-07A history rows", () => {
  assert.equal(P107A_RECOVERY_MIGRATIONS.length, 21);
  assert.equal(P107A_RECOVERY_MIGRATIONS.at(-1), P107A_RECOVERY_MIGRATION);
  assert.deepEqual(
    parseP107AMigrationChecksumOutput(checksumManifestOutput()),
    SELECTED_IMAGE_CHECKSUMS,
  );
  const sql = buildP107ARecoveryPreflightSql(SELECTED_IMAGE_CHECKSUMS);
  for (const migration of P107A_RECOVERY_MIGRATIONS) {
    assert.match(
      sql,
      new RegExp(`\\('${migration}', '${SELECTED_IMAGE_CHECKSUMS[migration]}'\\)`),
    );
  }
  assert.doesNotMatch(
    sql,
    /__CHARITYPILOT_P107A_SELECTED_IMAGE_CHECKSUM_VALUES__/,
  );
  assert.throws(
    () => parseP107AMigrationChecksumOutput(
      checksumManifestOutput({ unexpected_migration: "a".repeat(64) }),
    ),
    /exactly the 21 reviewed P1-07A migration names/,
  );
});

test("P1-07A recovery rejects trailing SQL that could mask its terminal invariant", () => {
  const sql = buildP107ARecoveryPreflightSql(SELECTED_IMAGE_CHECKSUMS);
  assert.equal(assertP107ARecoveryPreflightTerminalAssertion(sql), sql);
  for (const suffix of ["\nROLLBACK;", "\nCOMMIT;", "\nSELECT 1;"]) {
    assert.throws(
      () => assertP107ARecoveryPreflightTerminalAssertion(`${sql}${suffix}`),
      /terminal assertion|terminal SQL statement/,
    );
  }
});

test("dry-run validates exact env/image attestation under the shared lock and prints only a sanitized ordered plan", () => {
  const value = fixture();
  let commandCalled = false;
  let delegatedLock;
  try {
    const recoveryResult = runProductionP107ARecoveryFromArgs(
      [...value.args, "--dry-run"],
      dependencies({
        cutoverLockPath: value.lockPath,
        runCommand: () => {
          commandCalled = true;
          throw new Error("dry-run must not run Docker");
        },
        runDeploy: (args, nestedDependencies) => {
          delegatedLock = nestedDependencies.cutoverLock;
          assertProductionCutoverLock(delegatedLock);
          assert.ok(args.includes("--dry-run"));
          return {
            status: 0,
            stdout: `complete deploy dry-run ${value.envPath} ${value.backupOutputDir}\n`,
            stderr: "",
          };
        },
      }),
    );
    assert.equal(recoveryResult.status, 0, recoveryResult.stderr);
    assert.equal(commandCalled, false);
    assert.ok(delegatedLock);
    assert.equal(existsSync(value.lockPath), false);
    assert.doesNotMatch(recoveryResult.stdout, /operator:secret/);
    assert.doesNotMatch(
      recoveryResult.stdout,
      new RegExp(value.envPath.replaceAll("\\", "\\\\")),
    );
    assert.match(recoveryResult.stdout, /Hash all 21 reviewed migration files/);
    assert.match(recoveryResult.stdout, /target-catalog-residue/);
    assert.match(
      recoveryResult.stdout,
      new RegExp(`migrate migrate resolve --rolled-back ${P107A_RECOVERY_MIGRATION}`),
    );
    const ordered = [
      "1. Pull",
      "2. Hash all 21",
      "3. Re-quiesce",
      "4. Run the checksum-bound",
      "5. Mark only",
      "6. Immediately run",
    ].map((label) => recoveryResult.stdout.indexOf(label));
    assert.ok(ordered.every((position) => position >= 0));
    assert.deepEqual([...ordered].sort((a, b) => a - b), ordered);
  } finally {
    cleanFixture(value);
  }
});

test("live recovery orders pull, artifact checksums, re-quiesce, terminal SQL, exact resolution, and complete reentrant deploy", () => {
  const value = fixture();
  const events = [];
  const commands = [];
  try {
    const recoveryResult = runProductionP107ARecoveryFromArgs(
      value.args,
      dependencies({
        cutoverLockPath: value.lockPath,
        runPreflight: () => {
          events.push("preflight");
          return { status: 0, stdout: "preflight ok\n", stderr: "" };
        },
        runCommand: (command, _env, options) => {
          commands.push({ command, input: options?.input });
          if (command.includes("pull")) events.push("pull");
          else if (command.includes(P107A_RECOVERY_IMAGE_CHECKSUM_SCRIPT)) {
            events.push("checksum");
            return successfulRunCommand(command);
          } else if (command.includes("down")) events.push("quiesce");
          else if (command.includes("execute")) events.push("sql");
          else if (command.includes("resolve")) events.push("resolve");
          return { status: 0, stdout: "", stderr: "" };
        },
        runDeploy: (args, nestedDependencies) => {
          events.push("deploy");
          assertProductionCutoverLock(nestedDependencies.cutoverLock);
          assert.equal(args.includes("--dry-run"), false);
          assert.ok(args.includes("--backup-output-dir"));
          return {
            status: 0,
            stdout: "backup migration status reconciliation startup smoke complete\n",
            stderr: "",
          };
        },
      }),
    );
    assert.equal(recoveryResult.status, 0, recoveryResult.stderr);
    assert.deepEqual(events, [
      "preflight",
      "pull",
      "checksum",
      "quiesce",
      "sql",
      "resolve",
      "deploy",
    ]);
    const sqlCommand = commands.find(({ command }) => command.includes("execute"));
    assert.equal(
      sqlCommand.input,
      buildP107ARecoveryPreflightSql(SELECTED_IMAGE_CHECKSUMS),
    );
    const resolveCommand = commands.find(({ command }) => command.includes("resolve"));
    assert.equal(
      resolveCommand.command.filter((part) => part === P107A_RECOVERY_MIGRATION).length,
      1,
    );
    assert.ok(resolveCommand.command.includes("--rolled-back"));
    assert.equal(resolveCommand.command.includes("--applied"), false);
    assert.match(recoveryResult.stdout, /complete production deploy path/);
    assert.equal(existsSync(value.lockPath), false);
  } finally {
    cleanFixture(value);
  }
});

test("catalog/data SQL failure blocks resolution, redacts diagnostics, and re-quiesces", () => {
  const value = fixture();
  const commands = [];
  let deployCalled = false;
  try {
    const recoveryResult = runProductionP107ARecoveryFromArgs(
      value.args,
      dependencies({
        cutoverLockPath: value.lockPath,
        runCommand: (command) => {
          commands.push(command);
          if (command.includes(P107A_RECOVERY_IMAGE_CHECKSUM_SCRIPT)) {
            return successfulRunCommand(command);
          }
          if (command.includes("execute")) {
            return {
              status: 1,
              stdout: "",
              stderr:
                "P1-07A recovery active-principal data preflight failed: legacy_half_pairs=1 DATABASE_URL=postgresql://operator:secret@db/charitypilot",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
        runDeploy: () => {
          deployCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    );
    assert.equal(recoveryResult.status, 1);
    assert.equal(deployCalled, false);
    assert.equal(commands.some((command) => command.includes("resolve")), false);
    assert.equal(commands.filter((command) => command.includes("down")).length, 2);
    assert.match(recoveryResult.stderr, /legacy_half_pairs=1/);
    assert.doesNotMatch(recoveryResult.stderr, /operator:secret/);
    assert.match(recoveryResult.stderr, /DATABASE_URL=\[redacted\]/);
    assert.match(recoveryResult.stderr, /No migration-history resolution was accepted/);
  } finally {
    cleanFixture(value);
  }
});

test("selected-image checksum is passed into SQL and a rejection cannot resolve history", () => {
  const value = fixture();
  const tampered = "f".repeat(64);
  let resolveCalled = false;
  try {
    const recoveryResult = runProductionP107ARecoveryFromArgs(
      value.args,
      dependencies({
        cutoverLockPath: value.lockPath,
        runCommand: (command, _env, options) => {
          if (command.includes(P107A_RECOVERY_IMAGE_CHECKSUM_SCRIPT)) {
            return {
              status: 0,
              stdout: checksumManifestOutput({ [P107A_RECOVERY_MIGRATION]: tampered }),
              stderr: "",
            };
          }
          if (command.includes("execute")) {
            assert.match(
              options.input,
              new RegExp(`\\('${P107A_RECOVERY_MIGRATION}', '${tampered}'\\)`),
            );
            return { status: 1, stdout: "", stderr: "migration checksum mismatch" };
          }
          if (command.includes("resolve")) resolveCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    );
    assert.equal(recoveryResult.status, 1);
    assert.equal(resolveCalled, false);
    assert.match(recoveryResult.stderr, /migration checksum mismatch/);
  } finally {
    cleanFixture(value);
  }
});

test("fresh attestation, immutable env bytes, and cutover lock all fail closed before resolution", () => {
  const scenarios = [
    { attestationOverrides: { assessedAt: "2026-07-11T20:00:00.000Z" }, expected: /30 minutes old/ },
    { attestationOverrides: { migrationImage: `ghcr.io/wrong@sha256:${"b".repeat(64)}` }, expected: /migrationImage/ },
    { attestationOverrides: { acknowledgement: "partial" }, expected: /acknowledgement/ },
    { attestationOverrides: { targetCatalogRollbackVerified: false }, expected: /targetCatalogRollbackVerified/ },
  ];
  for (const scenario of scenarios) {
    const value = fixture(scenario);
    let commandCalled = false;
    try {
      const recoveryResult = runProductionP107ARecoveryFromArgs(
        value.args,
        dependencies({
          cutoverLockPath: value.lockPath,
          runCommand: () => {
            commandCalled = true;
            return { status: 0, stdout: "", stderr: "" };
          },
        }),
      );
      assert.equal(recoveryResult.status, 1);
      assert.equal(commandCalled, false);
      assert.match(recoveryResult.stderr, scenario.expected);
    } finally {
      cleanFixture(value);
    }
  }

  const value = fixture();
  const heldLock = acquireProductionCutoverLock({ lockPath: value.lockPath });
  try {
    const recoveryResult = runProductionP107ARecoveryFromArgs(
      value.args,
      dependencies({ cutoverLockPath: value.lockPath }),
    );
    assert.equal(recoveryResult.status, 1);
    assert.match(recoveryResult.stderr, /cutover lock is already held/);
  } finally {
    releaseProductionCutoverLock(heldLock);
    cleanFixture(value);
  }
});

test("delegated complete deploy failure is preserved, redacted, and followed by fail-closed re-quiesce", () => {
  const value = fixture();
  const commands = [];
  try {
    const recoveryResult = runProductionP107ARecoveryFromArgs(
      value.args,
      dependencies({
        cutoverLockPath: value.lockPath,
        runCommand: (command) => {
          commands.push(command);
          return successfulRunCommand(command);
        },
        runDeploy: (_args, nestedDependencies) => {
          assertProductionCutoverLock(nestedDependencies.cutoverLock);
          return {
            status: 1,
            stdout: "retained deploy diagnostics\n",
            stderr: "DATABASE_URL=postgresql://operator:secret@db/charitypilot",
          };
        },
      }),
    );
    assert.equal(recoveryResult.status, 1);
    assert.match(recoveryResult.stdout, /retained deploy diagnostics/);
    assert.match(recoveryResult.stderr, /delegated production deploy did not complete/);
    assert.doesNotMatch(recoveryResult.stderr, /operator:secret/);
    assert.equal(commands.filter((command) => command.includes("down")).length, 2);
  } finally {
    cleanFixture(value);
  }
});

test("unsafe or incomplete P1-07A CLI options fail before cutover-lock acquisition", () => {
  const value = fixture();
  let lockCalled = false;
  try {
    for (const args of [
      ["--production-env-file", value.envPath, "--backup-output-dir", value.tempDir],
      [...value.args, "--wait-timeout", "0"],
      [...value.args, "--unknown"],
      [...value.args, "--dry-run", "--dry-run"],
      [...value.args, "--recovery-attestation-file", value.attestationPath],
    ]) {
      const recoveryResult = runProductionP107ARecoveryFromArgs(args, {
        acquireCutoverLock: () => {
          lockCalled = true;
          throw new Error("must not acquire");
        },
      });
      assert.equal(recoveryResult.status, 2);
      assert.match(recoveryResult.stderr, /production-recover-p107a-migration\.mjs/);
    }
    assert.equal(lockCalled, false);
  } finally {
    cleanFixture(value);
  }
});
