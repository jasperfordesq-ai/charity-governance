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
  P109_RECOVERY_ACKNOWLEDGEMENT,
  P109_RECOVERY_CHECKSUM_OUTPUT_PREFIX,
  P109_RECOVERY_IMAGE_CHECKSUM_SCRIPT,
  P109_RECOVERY_MIGRATION,
  P109_RECOVERY_MIGRATIONS,
  P109_RECOVERY_PREFLIGHT_SQL,
  assertP109RecoveryPreflightTerminalAssertion,
  buildP109RecoveryPreflightSql,
  parseP109MigrationChecksumOutput,
  runProductionP109RecoveryFromArgs,
} from "./production-recover-p109-migration.mjs";
import {
  acquireProductionCutoverLock,
  assertProductionCutoverLock,
  releaseProductionCutoverLock,
} from "./production-cutover-lock.mjs";

const NOW = new Date("2026-07-11T20:00:00.000Z");
const MIGRATION_IMAGE =
  `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${"a".repeat(64)}`;
const SELECTED_IMAGE_CHECKSUMS = Object.fromEntries(
  P109_RECOVERY_MIGRATIONS.map((migration) => [
    migration,
    sha256(Buffer.from(`selected-image:${migration}`)),
  ]),
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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
  return `${P109_RECOVERY_CHECKSUM_OUTPUT_PREFIX}${JSON.stringify({
    schemaVersion: 1,
    migrations: { ...SELECTED_IMAGE_CHECKSUMS, ...overrides },
  })}\n`;
}

function successfulRunCommand(command) {
  if (command.includes(P109_RECOVERY_IMAGE_CHECKSUM_SCRIPT)) {
    return { status: 0, stdout: checksumManifestOutput(), stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
}

function recoveryAttestation(envPath, envBytes, overrides = {}) {
  return JSON.stringify({
    kind: "charitypilot-p109-failed-migration-recovery-attestation",
    schemaVersion: 1,
    environment: "production",
    migrationName: P109_RECOVERY_MIGRATION,
    assessedAt: "2026-07-11T19:50:00.000Z",
    productionEnvFile: basename(envPath),
    productionEnvSha256: sha256(envBytes),
    migrationImage: MIGRATION_IMAGE,
    operator: "named-operations-owner",
    evidenceReference: "incident://INC-2026-0711/p109-recovery",
    runtimeQuiesced: true,
    failedMigrationTransactionRolledBack: true,
    targetCatalogRollbackVerified: true,
    remediationOrUnexpectedWriterResolutionCompleted: true,
    acknowledgement: P109_RECOVERY_ACKNOWLEDGEMENT,
    ...overrides,
  });
}

function fixture(overrides = {}) {
  const tempDir = mkdtempSync(
    join(tmpdir(), "charitypilot-p109-production-recovery-test-"),
  );
  const envPath = join(tempDir, "production.env");
  const attestationPath = join(tempDir, "recovery-attestation.json");
  const lockPath = join(tempDir, "cutover.lock");
  const backupOutputDir = join(
    tmpdir(),
    `charitypilot-p109-recovery-backups-${process.pid}-${Date.now()}`,
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
      stdout: "delegated deploy ok\n",
      stderr: "",
    }),
    ...overrides,
  };
}

function cleanFixture(value) {
  rmSync(value.tempDir, { recursive: true, force: true });
}

test("P1-09 recovery SQL is read-only and checks exact history, catalog, legacy objects, and all six data blockers", () => {
  assert.match(
    P109_RECOVERY_PREFLIGHT_SQL,
    /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;/,
  );
  assert.match(
    P109_RECOVERY_PREFLIGHT_SQL,
    /END;\n\$p109_recovery\$;$/,
    "the invariant DO block must be the terminal statement so Prisma cannot mask a raised exception",
  );
  assert.doesNotMatch(
    P109_RECOVERY_PREFLIGHT_SQL,
    /\b(?:COMMIT|ROLLBACK)\s*;/i,
    "the short-lived Prisma connection must close and roll back the successful read-only transaction; a trailing transaction command masks DO failures",
  );
  assert.doesNotMatch(
    P109_RECOVERY_PREFLIGHT_SQL,
    /^\s*(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/im,
  );
  assert.match(
    P109_RECOVERY_PREFLIGHT_SQL,
    new RegExp(P109_RECOVERY_MIGRATION),
  );
  assert.match(P109_RECOVERY_PREFLIGHT_SQL, /target_rows <> 1/);
  assert.match(P109_RECOVERY_PREFLIGHT_SQL, /target_failed_rows <> 1/);
  assert.doesNotMatch(
    P109_RECOVERY_PREFLIGHT_SQL,
    /logs\s+IS\s+NOT\s+NULL|LENGTH\s*\(\s*logs\s*\)/i,
    "Prisma 6.19.3 may leave logs null for an explicitly transactional failed migration",
  );
  assert.match(P109_RECOVERY_PREFLIGHT_SQL, /unresolved_rows <> 1/);
  assert.match(P109_RECOVERY_PREFLIGHT_SQL, /previous_applied_rows <> 1/);
  assert.match(P109_RECOVERY_PREFLIGHT_SQL, /applied_predecessor_rows <> 19/);
  assert.match(
    P109_RECOVERY_PREFLIGHT_SQL,
    /applied_predecessor_distinct_rows <> 19/,
  );
  assert.match(P109_RECOVERY_PREFLIGHT_SQL, /total_history_rows <> 20/);
  assert.match(P109_RECOVERY_PREFLIGHT_SQL, /unexpected_history_rows <> 0/);
  assert.match(P109_RECOVERY_PREFLIGHT_SQL, /later_applied_rows <> 0/);
  assert.match(P109_RECOVERY_PREFLIGHT_SQL, /checksum_mismatch_rows <> 0/);
  assert.match(
    P109_RECOVERY_PREFLIGHT_SQL,
    /migration_history\.checksum IS DISTINCT FROM selected_image\.checksum/,
  );
  assert.match(P109_RECOVERY_PREFLIGHT_SQL, /started_at > target_started_at/);
  assert.equal(
    P109_RECOVERY_PREFLIGHT_SQL.match(/2026\d{10}_[a-z0-9_]+/g).filter(
      (migration, index, migrations) =>
        migrations.indexOf(migration) === index &&
        migration !== P109_RECOVERY_MIGRATION,
    ).length,
    19,
  );

  for (const catalogObject of [
    "BoardMember_term_chronology_check",
    "BoardMember_conduct_signed_date_equivalence_check",
    "BoardMember_induction_date_equivalence_check",
    "FundraisingRecord_date_chronology_check",
    "AnnualReportReadiness_filed_date_required_check",
    "BoardMember_id_organisationId_key",
    "ConflictRecord_boardMemberId_organisationId_fkey",
    "ConflictRecord_boardMemberId_organisationId_idx",
    "ConflictRecord_boardMemberId_fkey",
    "ConflictRecord_boardMemberId_idx",
  ]) {
    assert.match(P109_RECOVERY_PREFLIGHT_SQL, new RegExp(catalogObject));
  }

  for (const blocker of [
    "board_chronology",
    "conduct_evidence",
    "induction_evidence",
    "fundraising_chronology",
    "filing_evidence",
    "conflict_scope",
  ]) {
    assert.match(P109_RECOVERY_PREFLIGHT_SQL, new RegExp(blocker));
  }
});

test("selected-image checksum manifest binds all 20 exact migration history rows", () => {
  const parsed = parseP109MigrationChecksumOutput(checksumManifestOutput());
  assert.deepEqual(parsed, SELECTED_IMAGE_CHECKSUMS);
  const sql = buildP109RecoveryPreflightSql(parsed);
  assert.match(sql, /END;\n\$p109_recovery\$;$/);
  assert.doesNotMatch(sql, /\b(?:COMMIT|ROLLBACK)\s*;/i);
  assert.doesNotMatch(
    sql,
    /__CHARITYPILOT_P109_SELECTED_IMAGE_CHECKSUM_VALUES__/,
  );
  assert.equal(P109_RECOVERY_MIGRATIONS.length, 20);
  for (const migration of P109_RECOVERY_MIGRATIONS) {
    assert.match(
      sql,
      new RegExp(`\\('${migration}', '${SELECTED_IMAGE_CHECKSUMS[migration]}'\\)`),
    );
  }
  assert.throws(
    () =>
      parseP109MigrationChecksumOutput(
        checksumManifestOutput({ unexpected_migration: "a".repeat(64) }),
      ),
    /exactly the 20 reviewed P1-09 migration names/,
  );
  assert.throws(
    () =>
      parseP109MigrationChecksumOutput(
        `${checksumManifestOutput()}${checksumManifestOutput()}`,
      ),
    /exactly one P1-09 checksum manifest marker/,
  );
});

test("P1-09 recovery rejects every trailing statement that could mask its terminal invariant failure", () => {
  const sql = buildP109RecoveryPreflightSql(SELECTED_IMAGE_CHECKSUMS);
  assert.equal(assertP109RecoveryPreflightTerminalAssertion(sql), sql);
  for (const unsafeSuffix of ["\nROLLBACK;", "\nCOMMIT;", "\nSELECT 1;"]) {
    assert.throws(
      () => assertP109RecoveryPreflightTerminalAssertion(`${sql}${unsafeSuffix}`),
      /terminal assertion|terminal SQL statement/,
    );
  }
});

test("dry-run validates under the cutover lock and prints an ordered sanitized TLS plan without commands", () => {
  const value = fixture();
  let commandCalled = false;
  let delegatedLock;
  try {
    const recoveryResult = runProductionP109RecoveryFromArgs(
      [...value.args, "--dry-run"],
      dependencies({
        cutoverLockPath: value.lockPath,
        runCommand: () => {
          commandCalled = true;
          throw new Error("dry-run must not run Docker commands");
        },
        runDeploy: (args, nestedDependencies) => {
          delegatedLock = nestedDependencies.cutoverLock;
          assertProductionCutoverLock(delegatedLock);
          assert.ok(args.includes("--dry-run"));
          return {
            status: 0,
            stdout:
              `Production compose deploy dry-run for ${value.envPath} and ${value.backupOutputDir}\n`,
            stderr: "",
          };
        },
      }),
    );

    assert.equal(recoveryResult.status, 0, recoveryResult.stderr);
    assert.equal(commandCalled, false);
    assert.ok(delegatedLock);
    assert.equal(existsSync(value.lockPath), false);
    assert.doesNotMatch(recoveryResult.stdout, new RegExp(value.envPath.replaceAll("\\", "\\\\")));
    assert.doesNotMatch(recoveryResult.stdout, /operator:secret/);
    assert.match(recoveryResult.stdout, /-f compose\.production-tls\.yml/);
    assert.match(recoveryResult.stdout, /run -T --rm --no-deps migrate db execute --stdin/);
    assert.match(
      recoveryResult.stdout,
      new RegExp(`migrate migrate resolve --rolled-back ${P109_RECOVERY_MIGRATION}`),
    );
    assert.match(
      recoveryResult.stdout,
      /--entrypoint node migrate -e "?<repository-owned-checksum-script>"?/,
    );
    const pull = recoveryResult.stdout.indexOf("1. Pull");
    const checksum = recoveryResult.stdout.indexOf("2. Hash all 20");
    const quiesce = recoveryResult.stdout.indexOf("3. Re-quiesce");
    const sql = recoveryResult.stdout.indexOf("4. Run the checksum-bound");
    const resolveStep = recoveryResult.stdout.indexOf("5. Mark only");
    const deploy = recoveryResult.stdout.indexOf("6. Immediately run");
    assert.ok(
      pull < checksum &&
        checksum < quiesce &&
        quiesce < sql &&
        sql < resolveStep &&
        resolveStep < deploy,
    );
  } finally {
    cleanFixture(value);
  }
});

test("no-TLS dry-run forwards the explicit wait timeout and omits the proxy overlay", () => {
  const value = fixture();
  let delegatedArgs;
  try {
    const recoveryResult = runProductionP109RecoveryFromArgs(
      [...value.args, "--dry-run", "--no-tls-proxy", "--wait-timeout", "240"],
      dependencies({
        cutoverLockPath: value.lockPath,
        runDeploy: (args) => {
          delegatedArgs = args;
          return { status: 0, stdout: "nested no-TLS plan\n", stderr: "" };
        },
      }),
    );

    assert.equal(recoveryResult.status, 0, recoveryResult.stderr);
    assert.doesNotMatch(recoveryResult.stdout, /compose\.production-tls\.yml/);
    assert.deepEqual(delegatedArgs.slice(-3), [
      "240",
      "--dry-run",
      "--no-tls-proxy",
    ]);
  } finally {
    cleanFixture(value);
  }
});

test("live recovery orders preflight, pull, quiesce, read-only SQL, exact resolve, and reentrant deploy", () => {
  const value = fixture();
  const events = [];
  const commands = [];
  try {
    const recoveryResult = runProductionP109RecoveryFromArgs(
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
          else if (command.includes(P109_RECOVERY_IMAGE_CHECKSUM_SCRIPT)) {
            events.push("checksum");
            return successfulRunCommand(command);
          }
          else if (command.includes("down")) events.push("quiesce");
          else if (command.includes("execute")) events.push("sql");
          else if (command.includes("resolve")) events.push("resolve");
          return { status: 0, stdout: "", stderr: "" };
        },
        runDeploy: (args, nestedDependencies) => {
          events.push("deploy");
          assertProductionCutoverLock(nestedDependencies.cutoverLock);
          assert.equal(args.includes("--dry-run"), false);
          return { status: 0, stdout: "deploy ok\n", stderr: "" };
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
    const validatedEnvPath =
      sqlCommand.command[sqlCommand.command.indexOf("--env-file") + 1];
    assert.notEqual(validatedEnvPath, value.envPath);
    assert.equal(existsSync(validatedEnvPath), false);
    assert.deepEqual(
      sqlCommand.command.slice(-6),
      [
        "migrate",
        "db",
        "execute",
        "--stdin",
        "--schema",
        "prisma/schema.prisma",
      ],
    );
    assert.equal(
      sqlCommand.input,
      buildP109RecoveryPreflightSql(SELECTED_IMAGE_CHECKSUMS),
    );
    const resolveCommand = commands.find(({ command }) => command.includes("resolve"));
    assert.equal(
      resolveCommand.command.filter((part) => part === P109_RECOVERY_MIGRATION).length,
      1,
    );
    assert.ok(resolveCommand.command.includes("--rolled-back"));
    assert.equal(resolveCommand.command.includes("--applied"), false);
    assert.equal(existsSync(value.lockPath), false);
  } finally {
    cleanFixture(value);
  }
});

test("cutover lock contention fails before env, attestation, preflight, or Docker validation", () => {
  const value = fixture();
  const heldLock = acquireProductionCutoverLock({ lockPath: value.lockPath });
  let preflightCalled = false;
  try {
    const recoveryResult = runProductionP109RecoveryFromArgs(
      value.args,
      dependencies({
        cutoverLockPath: value.lockPath,
        runPreflight: () => {
          preflightCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
    );
    assert.equal(recoveryResult.status, 1);
    assert.equal(preflightCalled, false);
    assert.match(recoveryResult.stderr, /failed before validation/);
    assert.match(recoveryResult.stderr, /cutover lock is already held/);
  } finally {
    releaseProductionCutoverLock(heldLock);
    cleanFixture(value);
  }
});

test("attestation tamper, stale time, and future time each fail before preflight or commands", async (context) => {
  const cases = [
    {
      name: "exact env bytes changed",
      setup: (value) => {
        writeFileSync(value.envPath, `${productionEnv()}# changed after attestation\n`);
      },
      expected: /productionEnvSha256 does not match the exact production env bytes/,
    },
    {
      name: "stale attestation",
      overrides: { assessedAt: "2026-07-11T19:29:59.000Z" },
      expected: /assessedAt must be no more than 30 minutes old/,
    },
    {
      name: "future attestation",
      overrides: { assessedAt: "2026-07-11T20:00:01.000Z" },
      expected: /assessedAt must not be in the future/,
    },
    {
      name: "non-ISO attestation time",
      overrides: { assessedAt: "July 11 2026 19:50 UTC" },
      expected: /assessedAt must be an exact UTC ISO-8601 timestamp/,
    },
    {
      name: "wrong migration digest",
      overrides: {
        migrationImage:
          `ghcr.io/jasperfordesq-ai/charity-governance-migrations@sha256:${"b".repeat(64)}`,
      },
      expected: /migrationImage does not match the exact selected migration image digest/,
    },
    {
      name: "partial acknowledgement",
      overrides: { failedMigrationTransactionRolledBack: false },
      expected: /failedMigrationTransactionRolledBack must be true/,
    },
    {
      name: "catalog rollback not verified",
      overrides: { targetCatalogRollbackVerified: false },
      expected: /targetCatalogRollbackVerified must be true/,
    },
    {
      name: "acknowledgement text is not exact",
      overrides: { acknowledgement: "I approve recovery." },
      expected: /acknowledgement must exactly equal/,
    },
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, () => {
      const value = fixture({ attestationOverrides: scenario.overrides });
      let preflightCalled = false;
      let commandCalled = false;
      try {
        scenario.setup?.(value);
        const recoveryResult = runProductionP109RecoveryFromArgs(
          value.args,
          dependencies({
            cutoverLockPath: value.lockPath,
            runPreflight: () => {
              preflightCalled = true;
              return { status: 0, stdout: "", stderr: "" };
            },
            runCommand: () => {
              commandCalled = true;
              return { status: 0, stdout: "", stderr: "" };
            },
          }),
        );
        assert.equal(recoveryResult.status, 1);
        assert.equal(preflightCalled, false);
        assert.equal(commandCalled, false);
        assert.match(recoveryResult.stderr, scenario.expected);
        assert.equal(existsSync(value.lockPath), false);
      } finally {
        cleanFixture(value);
      }
    });
  }
});

test("production env mutation after SQL fails before resolve and re-quiesces", () => {
  const value = fixture();
  const commands = [];
  let deployCalled = false;
  try {
    const recoveryResult = runProductionP109RecoveryFromArgs(
      value.args,
      dependencies({
        cutoverLockPath: value.lockPath,
        runCommand: (command) => {
          commands.push(command);
          if (command.includes(P109_RECOVERY_IMAGE_CHECKSUM_SCRIPT)) {
            return successfulRunCommand(command);
          }
          if (command.includes("execute")) {
            const envFileIndex = command.indexOf("--env-file");
            writeFileSync(
              command[envFileIndex + 1],
              `${productionEnv()}# concurrent change\n`,
            );
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
    assert.match(recoveryResult.stderr, /production env bytes changed/);
  } finally {
    cleanFixture(value);
  }
});

test("mixed-catalog SQL failure blocks resolve and deploy, redacts output, and re-quiesces", () => {
  const value = fixture();
  const commands = [];
  let deployCalled = false;
  try {
    const recoveryResult = runProductionP109RecoveryFromArgs(
      value.args,
      dependencies({
        cutoverLockPath: value.lockPath,
        runCommand: (command) => {
          commands.push(command);
          if (command.includes(P109_RECOVERY_IMAGE_CHECKSUM_SCRIPT)) {
            return successfulRunCommand(command);
          }
          if (command.includes("execute")) {
            return {
              status: 1,
              stdout: "",
              stderr:
                "P1-09 recovery refused a partial or mixed target catalog DATABASE_URL=postgresql://operator:secret@db/charitypilot",
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
    assert.match(recoveryResult.stderr, /partial or mixed target catalog/);
    assert.doesNotMatch(recoveryResult.stderr, /operator:secret/);
    assert.match(recoveryResult.stderr, /DATABASE_URL=\[redacted\]/);
  } finally {
    cleanFixture(value);
  }
});

test("tampered selected-image migration checksum fails the SQL gate before resolve", () => {
  const value = fixture();
  const commands = [];
  const tamperedTargetChecksum = "f".repeat(64);
  let deployCalled = false;
  try {
    const recoveryResult = runProductionP109RecoveryFromArgs(
      value.args,
      dependencies({
        cutoverLockPath: value.lockPath,
        runCommand: (command, _env, options) => {
          commands.push(command);
          if (command.includes(P109_RECOVERY_IMAGE_CHECKSUM_SCRIPT)) {
            return {
              status: 0,
              stdout: checksumManifestOutput({
                [P109_RECOVERY_MIGRATION]: tamperedTargetChecksum,
              }),
              stderr: "",
            };
          }
          if (command.includes("execute")) {
            assert.match(
              options.input,
              new RegExp(
                `\\('${P109_RECOVERY_MIGRATION}', '${tamperedTargetChecksum}'\\)`,
              ),
            );
            return {
              status: 1,
              stdout: "",
              stderr:
                "P1-09 recovery selected-image migration checksum mismatch",
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
    assert.match(recoveryResult.stderr, /migration checksum mismatch/);
    assert.match(recoveryResult.stderr, /No migration-history resolution was accepted/);
  } finally {
    cleanFixture(value);
  }
});

test("exact resolve failure blocks nested deploy and leaves the runtime quiesced", () => {
  const value = fixture();
  const commands = [];
  let deployCalled = false;
  try {
    const recoveryResult = runProductionP109RecoveryFromArgs(
      value.args,
      dependencies({
        cutoverLockPath: value.lockPath,
        runCommand: (command) => {
          commands.push(command);
          if (command.includes(P109_RECOVERY_IMAGE_CHECKSUM_SCRIPT)) {
            return successfulRunCommand(command);
          }
          if (command.includes("resolve")) {
            return { status: 1, stdout: "", stderr: "P3008 resolve refused" };
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
    assert.equal(commands.filter((command) => command.includes("resolve")).length, 1);
    assert.equal(commands.filter((command) => command.includes("down")).length, 2);
    assert.match(recoveryResult.stderr, /No migration-history resolution was accepted/);
  } finally {
    cleanFixture(value);
  }
});

test("nested deploy failure is preserved, redacted, and followed by another quiesce", () => {
  const value = fixture();
  const commands = [];
  try {
    const recoveryResult = runProductionP109RecoveryFromArgs(
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
            stdout: "nested stdout\n",
            stderr: "DATABASE_URL=postgresql://operator:secret@db/charitypilot",
          };
        },
      }),
    );
    assert.equal(recoveryResult.status, 1);
    assert.match(recoveryResult.stdout, /nested stdout/);
    assert.match(recoveryResult.stderr, /delegated production deploy did not complete/);
    assert.doesNotMatch(recoveryResult.stderr, /operator:secret/);
    assert.equal(commands.filter((command) => command.includes("down")).length, 2);
    assert.equal(existsSync(value.lockPath), false);
  } finally {
    cleanFixture(value);
  }
});

test("lock-release failure preserves the prior dry-run result and reports operator action", () => {
  const value = fixture();
  let acquiredLock;
  try {
    const recoveryResult = runProductionP109RecoveryFromArgs(
      [...value.args, "--dry-run"],
      dependencies({
        acquireCutoverLock: (options) => {
          acquiredLock = acquireProductionCutoverLock(options);
          return acquiredLock;
        },
        releaseCutoverLock: () => {
          throw new Error("simulated lock release failure");
        },
        cutoverLockPath: value.lockPath,
        runDeploy: () => ({
          status: 0,
          stdout: "delegated plan retained\n",
          stderr: "",
        }),
      }),
    );
    assert.equal(recoveryResult.status, 1);
    assert.match(recoveryResult.stdout, /delegated plan retained/);
    assert.match(recoveryResult.stderr, /could not release the host cutover lock/);
    assert.match(recoveryResult.stderr, /simulated lock release failure/);
    assert.match(recoveryResult.stderr, /prior recovery result is preserved/);
  } finally {
    if (acquiredLock && existsSync(value.lockPath)) {
      releaseProductionCutoverLock(acquiredLock);
    }
    cleanFixture(value);
  }
});

test("unsafe or incomplete CLI options fail before lock acquisition", () => {
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
      const recoveryResult = runProductionP109RecoveryFromArgs(args, {
        acquireCutoverLock: () => {
          lockCalled = true;
          throw new Error("must not acquire");
        },
      });
      assert.equal(recoveryResult.status, 2);
    }
    assert.equal(lockCalled, false);
  } finally {
    cleanFixture(value);
  }
});
