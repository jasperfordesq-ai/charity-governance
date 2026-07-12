import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  redactProductionDeployTranscript,
  runProductionDeployPreflightFromArgs,
} from "./production-deploy-preflight.mjs";
import {
  acquireProductionCutoverLock,
  assertProductionCutoverLock,
  releaseProductionCutoverLock,
} from "./production-cutover-lock.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const DEFAULT_WAIT_TIMEOUT_SECONDS = 180;

function usage() {
  return [
    "Usage: node scripts/production-compose-deploy.mjs --production-env-file <path> --backup-output-dir <approved-encrypted-base> [--dry-run] [--wait-timeout <seconds>] [--no-tls-proxy]",
    "",
  ].join("\n");
}

function parsePositiveInteger(value, flagName) {
  if (!/^[1-9]\d*$/.test(value ?? "")) {
    throw new Error(`${flagName} must be a positive integer number of seconds`);
  }

  return Number(value);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    tlsProxy: true,
    productionEnvFile: ".env.production",
    backupOutputDir: null,
    waitTimeoutSeconds: DEFAULT_WAIT_TIMEOUT_SECONDS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--no-tls-proxy") {
      options.tlsProxy = false;
      continue;
    }
    if (arg === "--production-env-file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--production-env-file requires a value");
      options.productionEnvFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--production-env-file=")) {
      const value = arg.slice("--production-env-file=".length);
      if (!value) throw new Error("--production-env-file requires a value");
      options.productionEnvFile = value;
      continue;
    }
    if (arg === "--backup-output-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--backup-output-dir requires a value");
      options.backupOutputDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--backup-output-dir=")) {
      const value = arg.slice("--backup-output-dir=".length);
      if (!value) throw new Error("--backup-output-dir requires a value");
      options.backupOutputDir = value;
      continue;
    }
    if (arg === "--wait-timeout") {
      const value = argv[index + 1];
      if (!value) throw new Error("--wait-timeout requires a value");
      options.waitTimeoutSeconds = parsePositiveInteger(
        value,
        "--wait-timeout",
      );
      index += 1;
      continue;
    }
    if (arg.startsWith("--wait-timeout=")) {
      options.waitTimeoutSeconds = parsePositiveInteger(
        arg.slice("--wait-timeout=".length),
        "--wait-timeout",
      );
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.backupOutputDir) {
    throw new Error(
      "--backup-output-dir is required and must point to approved encrypted backup storage",
    );
  }
  const resolvedBackupBase = resolve(repoRoot, options.backupOutputDir);
  const relativeToRepo = relative(repoRoot, resolvedBackupBase);
  const insideRepo =
    relativeToRepo === "" ||
    (relativeToRepo !== ".." &&
      !relativeToRepo.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToRepo));
  if (!isAbsolute(options.backupOutputDir) || insideRepo) {
    throw new Error(
      "--backup-output-dir must be an absolute path outside the repository on approved encrypted storage",
    );
  }

  return options;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@,+-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function commandLine(command) {
  return command.map(shellQuote).join(" ");
}

function displayPreMigrationDatabaseProbeCommand(command) {
  const scriptIndex = command.indexOf("-e");
  if (scriptIndex < 0 || scriptIndex === command.length - 1) {
    return commandLine(command);
  }
  return commandLine([
    ...command.slice(0, scriptIndex + 1),
    "<embedded-exact-read-only-restored-history-probe>",
  ]);
}

function result(status, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

function defaultRunCommand(command, env) {
  const commandResult = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    stdio: "inherit",
  });

  if (commandResult.status !== 0) {
    throw new Error(
      `${commandLine(command)} failed with exit code ${commandResult.status ?? "unknown"}`,
    );
  }
}

function defaultRunSmoke(args, env) {
  const smokeResult = spawnSync(
    "node",
    ["scripts/smoke-production-deploy.mjs", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    },
  );

  return {
    status: smokeResult.status ?? 1,
    stdout: smokeResult.stdout ?? "",
    stderr: smokeResult.stderr ?? "",
  };
}

function defaultRunBackup(args, env) {
  const outputDirIndex = args.indexOf("--backup-output-dir");
  const configuredOutputDir =
    outputDirIndex >= 0 ? args[outputDirIndex + 1] : null;
  if (!configuredOutputDir) {
    return result(
      1,
      "",
      "Protected backup output directory was not provided.\n",
    );
  }

  const protectedOutputDir = resolve(repoRoot, configuredOutputDir);
  try {
    prepareProtectedBackupDirectory(protectedOutputDir);
  } catch {
    return result(
      1,
      "",
      "Could not prepare protected backup storage; verify the approved encrypted base exists, is writable by the deploy owner, and has sufficient capacity.\n",
    );
  }

  const backupResult = spawnSync(
    "node",
    ["scripts/check-production-database.mjs", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    },
  );

  const capturedResult = {
    status: backupResult.status ?? 1,
    stdout: backupResult.stdout ?? "",
    stderr: backupResult.stderr ?? "",
  };
  if (capturedResult.status !== 0) return capturedResult;

  try {
    protectBackupDump(protectedOutputDir);
    return capturedResult;
  } catch {
    return result(
      1,
      capturedResult.stdout,
      "Could not enforce owner-only permissions on the retained backup; the runtime remains stopped.\n",
    );
  }
}

export function prepareProtectedBackupDirectory(
  outputDir,
  { mkdir = mkdirSync, chmod = chmodSync } = {},
) {
  const baseDir = dirname(outputDir);
  mkdir(baseDir, { recursive: true, mode: 0o700 });
  chmod(baseDir, 0o700);
  mkdir(outputDir, { recursive: false, mode: 0o700 });
  chmod(outputDir, 0o700);
}

export function protectBackupDump(
  outputDir,
  { exists = existsSync, chmod = chmodSync } = {},
) {
  const dumpPath = join(outputDir, "production-check.dump");
  if (!exists(dumpPath)) {
    throw new Error(
      "backup checker reported success without creating production-check.dump",
    );
  }
  chmod(dumpPath, 0o600);
}

function composePrefix({ productionEnvFile, tlsProxy }) {
  return [
    "docker",
    "compose",
    "--env-file",
    productionEnvFile,
    "-f",
    "compose.production.yml",
    ...(tlsProxy ? ["-f", "compose.production-tls.yml"] : []),
  ];
}

function composePullCommand(options) {
  return [
    ...composePrefix(options),
    "--profile",
    "maintenance",
    "pull",
    "migrate",
    "api",
    "web",
    "production-scheduler",
    ...(options.tlsProxy ? ["caddy"] : []),
  ];
}

function composeQuiesceCommand(options) {
  return [
    ...composePrefix(options),
    "--profile",
    "maintenance",
    "--profile",
    "jobs",
    "down",
    "--remove-orphans",
  ];
}

function composeMigrateCommand(options) {
  return [
    ...composePrefix(options),
    "--profile",
    "maintenance",
    "run",
    "--rm",
    "--no-deps",
    "migrate",
  ];
}

function composeMigrationStatusCommand(options) {
  return [
    ...composePrefix(options),
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
  ];
}

function composeReminderReconciliationGateCommand(options) {
  return [
    ...composePrefix(options),
    "run",
    "--rm",
    "--no-deps",
    "api",
    "node",
    "dist/jobs/reconcile-deadline-reminder.js",
    "--prepare-quiesced-cutover",
    "--confirm-schedulers-quiesced",
  ];
}

function composeUpCommand(options) {
  return [
    ...composePrefix(options),
    "up",
    "--wait",
    "--wait-timeout",
    String(options.waitTimeoutSeconds),
    "-d",
    "--remove-orphans",
  ];
}

function failClosedCleanup(runCommand, command, env) {
  try {
    runCommand(command, env);
    return "";
  } catch (error) {
    const message = redactProductionDeployTranscript(
      error instanceof Error ? error.message : String(error),
    );
    return `Fail-closed runtime cleanup also failed: ${message}\nRun this command before any recovery action: ${commandLine(command)}\n`;
  }
}

function uniqueBackupOutputDir(baseDir, now, randomId) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return join(baseDir, `cutover-${timestamp}-${randomId}`);
}

export function runProductionComposeDeployFromArgs(
  args = process.argv.slice(2),
  {
    processEnv = process.env,
    runPreflight = runProductionDeployPreflightFromArgs,
    runCommand = defaultRunCommand,
    runBackup = defaultRunBackup,
    runSmoke = defaultRunSmoke,
    now = () => new Date(),
    randomId = randomUUID,
    cutoverLock = null,
    attestedDatabaseCompatibility = null,
    preMigrationDatabaseProbeCommand = null,
    cutoverLockPath = undefined,
    acquireCutoverLock = acquireProductionCutoverLock,
    releaseCutoverLock = releaseProductionCutoverLock,
  } = {},
) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    return result(2, "", `${usage()}${error.message}\n`);
  }
  if (
    attestedDatabaseCompatibility !== null &&
    attestedDatabaseCompatibility !== "p109-restored" &&
    attestedDatabaseCompatibility !== "pre-p006-restored" &&
    attestedDatabaseCompatibility !== "p006-restored"
  ) {
    return result(
      1,
      "",
      "Production compose deploy rejected an unsupported internal database-compatibility attestation.\n",
    );
  }
  const requiresP109RestoredProbe =
    attestedDatabaseCompatibility === "p109-restored";
  const hasPreMigrationDatabaseProbe =
    Array.isArray(preMigrationDatabaseProbeCommand) &&
    preMigrationDatabaseProbeCommand.length > 0 &&
    preMigrationDatabaseProbeCommand.every(
      (part) => typeof part === "string" && part.length > 0,
    );
  if (requiresP109RestoredProbe !== hasPreMigrationDatabaseProbe) {
    return result(
      1,
      "",
      requiresP109RestoredProbe
        ? "Production compose deploy requires the internal exact P1-09 restored-history probe before a p109-restored cutover.\n"
        : "Production compose deploy rejected an unexpected internal pre-migration database probe.\n",
    );
  }

  let ownedCutoverLock = null;
  try {
    if (cutoverLock) {
      assertProductionCutoverLock(cutoverLock);
    } else {
      ownedCutoverLock = acquireCutoverLock({ lockPath: cutoverLockPath });
    }
  } catch (error) {
    return result(
      1,
      "",
      `Production compose deploy failed before preflight: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  const executeCutover = () => {
    const preflightArgs = [
      "--production-env-file",
      options.productionEnvFile,
      ...(options.dryRun ? ["--dry-run"] : []),
      ...(options.tlsProxy ? [] : ["--no-tls-proxy"]),
    ];
    const expectedDatabaseCompatibility =
      attestedDatabaseCompatibility === "p109-restored"
        ? "p109-governance-integrity-v1"
        : attestedDatabaseCompatibility === "pre-p006-restored"
        ? "pre-p006-restored"
        : attestedDatabaseCompatibility === "p006-restored"
          ? "p006-deadline-calendar-v1"
          : "p107a-password-recovery-v1";
    const preflightResult = runPreflight(preflightArgs, processEnv, {
      expectedDatabaseCompatibility,
    });
    if (preflightResult.status !== 0) {
      return result(
        1,
        preflightResult.stdout,
        `Production compose deploy failed: preflight failed.\n${redactProductionDeployTranscript(preflightResult.stderr)}`,
      );
    }

    const commandEnvOverrides = {
      CHARITYPILOT_PRODUCTION_ENV_FILE: options.productionEnvFile,
    };
    const commandEnv = {
      ...processEnv,
      ...commandEnvOverrides,
    };
    const pullCommand = composePullCommand(options);
    const quiesceCommand = composeQuiesceCommand(options);
    const migrateCommand = composeMigrateCommand(options);
    const migrationStatusCommand = composeMigrationStatusCommand(options);
    const reminderReconciliationGateCommand = composeReminderReconciliationGateCommand(options);
    const skipReminderReconciliationGate =
      attestedDatabaseCompatibility === "pre-p006-restored";
    const command = composeUpCommand(options);
    const backupOutputDir = uniqueBackupOutputDir(
      options.backupOutputDir,
      now(),
      randomId(),
    );
    const backupArgs = [
      "--production-env-file",
      options.productionEnvFile,
      "--backup-output-dir",
      backupOutputDir,
      "--keep-backup",
    ];
    const backupCommand = [
      "node",
      "scripts/check-production-database.mjs",
      ...backupArgs,
    ];
    const smokeArgs = ["--production-env-file", options.productionEnvFile];
    const smokeCommand = [
      "node",
      "scripts/smoke-production-deploy.mjs",
      ...smokeArgs,
    ];

    if (options.dryRun) {
      return result(
        0,
        [
          "Production compose deploy dry-run:",
          "Preflight command:",
          commandLine([
            "node",
            "scripts/production-deploy-preflight.mjs",
            ...preflightArgs,
          ]),
          "Preflight validation output:",
          preflightResult.stdout.trimEnd(),
          "Compose environment:",
          ...Object.entries(commandEnvOverrides).map(
            ([key, value]) => `${key}=${value}`,
          ),
          "Pull promoted images before downtime:",
          commandLine(pullCommand),
          "Enter fail-closed maintenance mode (stops and removes API, web, scheduler, jobs, and proxy):",
          commandLine(quiesceCommand),
          ...(hasPreMigrationDatabaseProbe
            ? [
                "Prove the exact checksum-bound P1-09 restored history and P1-07A absence before any backup or migration:",
                displayPreMigrationDatabaseProbeCommand(
                  preMigrationDatabaseProbeCommand,
                ),
              ]
            : []),
          "Create and restore-verify the retained pre-migration PostgreSQL backup:",
          commandLine(
            backupCommand.map((part) =>
              part === backupOutputDir ? "<approved-backup-dir>" : part,
            ),
          ),
          "Run the migration image alone while the runtime is stopped:",
          commandLine(migrateCommand),
          "Probe live migration history compatibility before any runtime starts:",
          commandLine(migrationStatusCommand),
          skipReminderReconciliationGate
            ? "P0-06 reminder reconciliation gate skipped only because the rollback caller supplied a verified pre-P0-06 database-restore attestation."
            : "Require every ambiguous deadline reminder outcome to be reconciled before runtime starts:",
          ...(skipReminderReconciliationGate
            ? []
            : [commandLine(reminderReconciliationGateCommand)]),
          "Start only the promoted runtime:",
          commandLine(command),
          "Post-deploy smoke command:",
          commandLine([...smokeCommand, "--dry-run"]),
          "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    let runtimeQuiesced = false;
    let backupResult = result(1);
    try {
      runCommand(pullCommand, commandEnv);
      runCommand(quiesceCommand, commandEnv);
      runtimeQuiesced = true;

      if (hasPreMigrationDatabaseProbe) {
        runCommand(preMigrationDatabaseProbeCommand, commandEnv);
      }

      backupResult = runBackup(backupArgs, commandEnv);
      if (backupResult.status !== 0) {
        const cleanupError = failClosedCleanup(
          runCommand,
          quiesceCommand,
          commandEnv,
        );
        return result(
          1,
          `${preflightResult.stdout}${backupResult.stdout}`,
          `Production compose deploy failed: pre-migration backup/restore verification failed. The production runtime remains stopped; do not restart an older image after any schema change.\n${redactProductionDeployTranscript(backupResult.stderr)}${cleanupError}`,
        );
      }

      runCommand(migrateCommand, commandEnv);
      runCommand(migrationStatusCommand, commandEnv);
      if (!skipReminderReconciliationGate) {
        runCommand(reminderReconciliationGateCommand, commandEnv);
      }
      runCommand(command, commandEnv);
    } catch (error) {
      const message = redactProductionDeployTranscript(
        error instanceof Error ? error.message : String(error),
      );
      const cleanupError = runtimeQuiesced
        ? failClosedCleanup(runCommand, quiesceCommand, commandEnv)
        : "";
      const posture = runtimeQuiesced
        ? " The production runtime remains stopped; recover by rolling forward, or restore the pre-migration database backup before deliberately selecting older images."
        : " No migration was attempted.";
      return result(
        1,
        `${preflightResult.stdout}${backupResult.stdout}`,
        `Production compose deploy failed: ${message}.${posture}\n${cleanupError}`,
      );
    }

    const smokeResult = runSmoke(smokeArgs, commandEnv);
    if (smokeResult.status !== 0) {
      const cleanupError = failClosedCleanup(
        runCommand,
        quiesceCommand,
        commandEnv,
      );
      return result(
        1,
        `${preflightResult.stdout}${backupResult.stdout}${smokeResult.stdout}`,
        `Production compose deploy failed: post-deploy smoke failed. The promoted runtime was stopped and will not fall back to an older image automatically.\n${redactProductionDeployTranscript(smokeResult.stderr)}${cleanupError}`,
      );
    }

    return result(
      0,
      `${preflightResult.stdout}${backupResult.stdout}${smokeResult.stdout}${hasPreMigrationDatabaseProbe ? 'Exact restored-database history was proven read-only before any backup or migration.\n' : ''}${skipReminderReconciliationGate ? '' : 'P0-06 quiesced reminder cutover preparation completed with zero unresolved reminder outcomes.\n'}Retained pre-migration PostgreSQL backup created with owner-only permissions (path omitted from transcript).\nProduction compose deploy completed.\n`,
    );
  };

  let deployResult;
  let operationError;
  try {
    deployResult = executeCutover();
  } catch (error) {
    operationError = error;
  }

  if (ownedCutoverLock) {
    try {
      releaseCutoverLock(ownedCutoverLock);
    } catch (error) {
      const priorError = deployResult?.stderr
        ? `${deployResult.stderr.trimEnd()}\n`
        : operationError
          ? `Production compose deploy failed unexpectedly: ${redactProductionDeployTranscript(operationError instanceof Error ? operationError.message : String(operationError))}\n`
          : "";
      const releaseError = redactProductionDeployTranscript(
        error instanceof Error ? error.message : String(error),
      );
      return result(
        1,
        deployResult?.stdout ?? "",
        `${priorError}Production compose deploy could not release the host cutover lock: ${releaseError}. The prior deployment result is preserved above; do not start another deploy or rollback until the lock owner and runtime state are reconciled.\n`,
      );
    }
  }

  if (operationError) throw operationError;
  return deployResult;
}

function main() {
  const deployResult = runProductionComposeDeployFromArgs();
  if (deployResult.stdout) process.stdout.write(deployResult.stdout);
  if (deployResult.stderr) process.stderr.write(deployResult.stderr);
  process.exit(deployResult.status);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
