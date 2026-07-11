#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProductionComposeDeployFromArgs } from "./production-compose-deploy.mjs";
import { redactProductionDeployTranscript } from "./production-deploy-preflight.mjs";
import {
  acquireProductionCutoverLock,
  releaseProductionCutoverLock,
} from "./production-cutover-lock.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const DATABASE_COMPATIBILITY_ENV = "CHARITYPILOT_DATABASE_COMPATIBILITY";
const P006_DATABASE_COMPATIBILITY = "p006-deadline-calendar-v1";
const RESTORE_ATTESTATION_KIND = "charitypilot-database-restore-attestation";
const COMPATIBILITY_ATTESTATION_KIND =
  "charitypilot-schema-compatibility-attestation";
const MAX_ATTESTATION_AGE_MS = 30 * 60 * 1000;
const RESTORE_ACKNOWLEDGEMENT =
  "I confirm the production runtime was stopped and the database was restored from a backup captured before the incompatible migration.";
const COMPATIBILITY_ACKNOWLEDGEMENT =
  "I confirm the selected application images are compatible with the live P0-06 database schema and migration history.";

const requiredImages = [
  {
    envName: "CHARITYPILOT_API_IMAGE",
    repository: "ghcr.io/jasperfordesq-ai/charity-governance-api",
  },
  {
    envName: "CHARITYPILOT_WEB_IMAGE",
    repository: "ghcr.io/jasperfordesq-ai/charity-governance-web",
  },
  {
    envName: "CHARITYPILOT_MIGRATION_IMAGE",
    repository: "ghcr.io/jasperfordesq-ai/charity-governance-migrations",
  },
];

const requiredWebBuildOrigins = [
  "CHARITYPILOT_WEB_BUILD_NEXT_PUBLIC_API_URL",
];

function usage() {
  return [
    "Usage: node scripts/production-compose-rollback.mjs --production-env-file <path> --rollback-digest-file <path> --backup-output-dir <approved-encrypted-base> (--schema-compatibility-attestation-file <path> | --database-restore-attestation-file <path> --restored-backup-file <path>) [--dry-run] [--wait-timeout <seconds>] [--no-tls-proxy]",
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
    rollbackDigestFile: null,
    schemaCompatibilityAttestationFile: null,
    databaseRestoreAttestationFile: null,
    restoredBackupFile: null,
    backupOutputDir: null,
    waitTimeoutSeconds: null,
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
    if (arg === "--rollback-digest-file" || arg === "--image-digest-file") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options.rollbackDigestFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--rollback-digest-file=")) {
      const value = arg.slice("--rollback-digest-file=".length);
      if (!value) throw new Error("--rollback-digest-file requires a value");
      options.rollbackDigestFile = value;
      continue;
    }
    if (arg.startsWith("--image-digest-file=")) {
      const value = arg.slice("--image-digest-file=".length);
      if (!value) throw new Error("--image-digest-file requires a value");
      options.rollbackDigestFile = value;
      continue;
    }
    if (arg === "--database-restore-attestation-file") {
      const value = argv[index + 1];
      if (!value)
        throw new Error("--database-restore-attestation-file requires a value");
      options.databaseRestoreAttestationFile = value;
      index += 1;
      continue;
    }
    if (arg === "--schema-compatibility-attestation-file") {
      const value = argv[index + 1];
      if (!value)
        throw new Error(
          "--schema-compatibility-attestation-file requires a value",
        );
      options.schemaCompatibilityAttestationFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--schema-compatibility-attestation-file=")) {
      const value = arg.slice(
        "--schema-compatibility-attestation-file=".length,
      );
      if (!value)
        throw new Error(
          "--schema-compatibility-attestation-file requires a value",
        );
      options.schemaCompatibilityAttestationFile = value;
      continue;
    }
    if (arg.startsWith("--database-restore-attestation-file=")) {
      const value = arg.slice("--database-restore-attestation-file=".length);
      if (!value)
        throw new Error("--database-restore-attestation-file requires a value");
      options.databaseRestoreAttestationFile = value;
      continue;
    }
    if (arg === "--restored-backup-file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--restored-backup-file requires a value");
      options.restoredBackupFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--restored-backup-file=")) {
      const value = arg.slice("--restored-backup-file=".length);
      if (!value) throw new Error("--restored-backup-file requires a value");
      options.restoredBackupFile = value;
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

  if (!options.rollbackDigestFile) {
    throw new Error("--rollback-digest-file is required");
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

function parseEnvFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} file not found: ${path}`);
  }

  const values = {};
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

function imageRefIssue({ envName, repository }, value) {
  if (!value) return `${envName} is required in the rollback digest manifest`;
  if (value.includes(":") && !value.includes("@sha256:")) {
    return `${envName} must be pinned to an immutable sha256 digest, not a mutable tag`;
  }

  const expected = new RegExp(
    `^${repository.replaceAll(".", "\\.")}@sha256:[a-f0-9]{64}$`,
  );
  if (!expected.test(value)) {
    return `${envName} must use ${repository}@sha256:<64 lowercase hex chars>`;
  }

  return null;
}

function validateRollbackImages(rollbackEnv) {
  const issues = [];
  for (const image of requiredImages) {
    const issue = imageRefIssue(image, rollbackEnv[image.envName]);
    if (issue) issues.push(issue);
  }
  for (const envName of requiredWebBuildOrigins) {
    if (!rollbackEnv[envName]) {
      issues.push(`${envName} is required in the rollback digest manifest`);
    }
  }

  if (issues.length > 0) {
    throw new Error(
      [
        `rollback digest manifest failed validation (${issues.length} issue${issues.length === 1 ? "" : "s"}):`,
        ...issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );
  }
}

function requiredAttestationString(attestation, key, issues) {
  const value = attestation?.[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${key} must be a non-empty string`);
    return "";
  }
  return value.trim();
}

export function sha256File(path) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, "r");
  try {
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function validateFreshTimestamp(attestation, key, issues, now) {
  const value = requiredAttestationString(attestation, key, issues);
  const timestamp = Date.parse(value);
  if (value && Number.isNaN(timestamp)) {
    issues.push(`${key} must be a valid ISO-8601 timestamp`);
  } else if (timestamp > now.getTime() + 5 * 60 * 1000) {
    issues.push(`${key} must not be in the future`);
  } else if (now.getTime() - timestamp > MAX_ATTESTATION_AGE_MS) {
    issues.push(`${key} must be no more than 30 minutes old`);
  }
}

function validateManifestBinding(attestation, rollbackDigestPath, issues) {
  const manifest = requiredAttestationString(
    attestation,
    "rollbackDigestManifest",
    issues,
  );
  if (manifest && manifest !== basename(rollbackDigestPath)) {
    issues.push(
      `rollbackDigestManifest must equal ${basename(rollbackDigestPath)}`,
    );
  }
  const expectedManifestHash = requiredAttestationString(
    attestation,
    "rollbackDigestManifestSha256",
    issues,
  );
  const actualManifestHash = sha256File(rollbackDigestPath);
  if (expectedManifestHash && expectedManifestHash !== actualManifestHash) {
    issues.push(
      "rollbackDigestManifestSha256 does not match the exact rollback digest manifest bytes",
    );
  }
}

function readAttestation(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} file not found`);
  }

  try {
    const attestation = JSON.parse(readFileSync(path, "utf8"));
    if (
      !attestation ||
      Array.isArray(attestation) ||
      typeof attestation !== "object"
    ) {
      throw new Error(`${label} must be a JSON object`);
    }
    return attestation;
  } catch {
    throw new Error(`${label} must contain valid JSON object data`);
  }
}

function validateSchemaCompatibilityAttestation(path, rollbackDigestPath, now) {
  const attestation = readAttestation(path, "schema compatibility attestation");
  const issues = [];
  if (attestation.kind !== COMPATIBILITY_ATTESTATION_KIND) {
    issues.push(`kind must be ${COMPATIBILITY_ATTESTATION_KIND}`);
  }
  if (attestation.schemaVersion !== 1) issues.push("schemaVersion must be 1");
  if (attestation.environment !== "production")
    issues.push("environment must be production");
  if (attestation.databaseCompatibility !== P006_DATABASE_COMPATIBILITY) {
    issues.push(`databaseCompatibility must be ${P006_DATABASE_COMPATIBILITY}`);
  }
  validateFreshTimestamp(attestation, "assessedAt", issues, now);
  validateManifestBinding(attestation, rollbackDigestPath, issues);
  requiredAttestationString(attestation, "evidenceReference", issues);
  requiredAttestationString(attestation, "operator", issues);
  if (attestation.acknowledgement !== COMPATIBILITY_ACKNOWLEDGEMENT) {
    issues.push(
      `acknowledgement must exactly equal: ${COMPATIBILITY_ACKNOWLEDGEMENT}`,
    );
  }

  if (issues.length > 0) {
    throw new Error(
      [
        `schema compatibility attestation failed validation (${issues.length} issue${issues.length === 1 ? "" : "s"}):`,
        ...issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );
  }
}

function validateDatabaseRestoreAttestation(
  path,
  rollbackDigestPath,
  restoredBackupPath,
  now = new Date(),
) {
  const attestation = readAttestation(path, "database restore attestation");

  const issues = [];
  if (attestation.kind !== RESTORE_ATTESTATION_KIND) {
    issues.push(`kind must be ${RESTORE_ATTESTATION_KIND}`);
  }
  if (attestation.schemaVersion !== 1) {
    issues.push("schemaVersion must be 1");
  }
  if (attestation.environment !== "production") {
    issues.push("environment must be production");
  }
  if (attestation.databaseRestoreCompleted !== true) {
    issues.push("databaseRestoreCompleted must be true");
  }
  if (attestation.runtimeStoppedDuringRestore !== true) {
    issues.push("runtimeStoppedDuringRestore must be true");
  }
  if (attestation.backupCapturedBeforeIncompatibleMigration !== true) {
    issues.push("backupCapturedBeforeIncompatibleMigration must be true");
  }

  validateFreshTimestamp(
    attestation,
    "databaseRestoreCompletedAt",
    issues,
    now,
  );

  requiredAttestationString(attestation, "backupReference", issues);
  requiredAttestationString(attestation, "restoreEvidenceReference", issues);
  requiredAttestationString(attestation, "operator", issues);
  validateManifestBinding(attestation, rollbackDigestPath, issues);
  const expectedBackupHash = requiredAttestationString(
    attestation,
    "restoredBackupSha256",
    issues,
  );
  if (!existsSync(restoredBackupPath)) {
    issues.push("restored backup file does not exist");
  } else if (
    expectedBackupHash &&
    expectedBackupHash !== sha256File(restoredBackupPath)
  ) {
    issues.push(
      "restoredBackupSha256 does not match the exact restored backup bytes",
    );
  }
  if (attestation.acknowledgement !== RESTORE_ACKNOWLEDGEMENT) {
    issues.push(
      `acknowledgement must exactly equal: ${RESTORE_ACKNOWLEDGEMENT}`,
    );
  }

  if (issues.length > 0) {
    throw new Error(
      [
        `database restore attestation failed validation (${issues.length} issue${issues.length === 1 ? "" : "s"}):`,
        ...issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );
  }
}

function validateRollbackCompatibility(
  rollbackEnv,
  options,
  rollbackDigestPath,
  now,
) {
  const compatibility = rollbackEnv[DATABASE_COMPATIBILITY_ENV]?.trim();
  if (compatibility === P006_DATABASE_COMPATIBILITY) {
    if (!options.schemaCompatibilityAttestationFile) {
      throw new Error(
        `image-only rollback requires --schema-compatibility-attestation-file bound to the exact rollback manifest; ${DATABASE_COMPATIBILITY_ENV} is necessary but is not trusted by itself.`,
      );
    }
    validateSchemaCompatibilityAttestation(
      resolve(repoRoot, options.schemaCompatibilityAttestationFile),
      rollbackDigestPath,
      now,
    );
    return {
      compatibility,
      posture: `Image rollback authorised by a fresh, manifest-bound schema compatibility attestation for ${P006_DATABASE_COMPATIBILITY}.`,
    };
  }

  if (!options.databaseRestoreAttestationFile) {
    throw new Error(
      `image-only rollback is forbidden because the rollback digest manifest does not declare ${DATABASE_COMPATIBILITY_ENV}=${P006_DATABASE_COMPATIBILITY}. ` +
        "Keep the runtime stopped, restore the production database from a backup captured before the incompatible migration, then provide --database-restore-attestation-file.",
    );
  }
  if (!options.restoredBackupFile) {
    throw new Error(
      "cross-boundary rollback requires --restored-backup-file so its SHA-256 can be verified against the restore attestation",
    );
  }

  const attestationPath = resolve(
    repoRoot,
    options.databaseRestoreAttestationFile,
  );
  const restoredBackupPath = resolve(repoRoot, options.restoredBackupFile);
  validateDatabaseRestoreAttestation(
    attestationPath,
    rollbackDigestPath,
    restoredBackupPath,
    now,
  );
  return {
    compatibility: "pre-p006-restored",
    posture:
      "Cross-boundary rollback authorised by a fresh exact-manifest-and-backup-hash-bound database restore attestation (path omitted).",
  };
}

function mergedEnvContent(productionEnvContent, rollbackEnv, compatibility) {
  const overrideLines = [];
  for (const { envName } of requiredImages) {
    overrideLines.push(`${envName}=${rollbackEnv[envName]}`);
  }
  for (const envName of requiredWebBuildOrigins) {
    overrideLines.push(`${envName}=${rollbackEnv[envName]}`);
  }
  overrideLines.push(`${DATABASE_COMPATIBILITY_ENV}=${compatibility}`);

  const preserved = productionEnvContent.endsWith("\n")
    ? productionEnvContent
    : `${productionEnvContent}\n`;
  return `${preserved}${overrideLines.join("\n")}\n`;
}

function result(status, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@,+-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function commandLine(command) {
  return command.map(shellQuote).join(" ");
}

function durableRecoveryCommand(options) {
  return commandLine([
    "docker",
    "compose",
    "--env-file",
    options.productionEnvFile,
    "-f",
    "compose.production.yml",
    ...(options.tlsProxy ? ["-f", "compose.production-tls.yml"] : []),
    "--profile",
    "maintenance",
    "--profile",
    "jobs",
    "down",
    "--remove-orphans",
  ]);
}

function sanitizeDelegatedTranscript(value, mergedEnvPath) {
  return String(value ?? "")
    .replaceAll(mergedEnvPath, "[temporary rollback env removed]")
    .replace(
      /Run this command before any recovery action:[^\r\n]*(?:\r?\n|$)/g,
      "",
    );
}

export function runProductionComposeRollbackFromArgs(
  args = process.argv.slice(2),
  {
    processEnv = process.env,
    runDeploy = runProductionComposeDeployFromArgs,
    now = () => new Date(),
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

  let cutoverLock;
  try {
    cutoverLock = acquireCutoverLock({ lockPath: cutoverLockPath });
  } catch (error) {
    return result(
      1,
      "",
      `Production compose rollback failed before validation: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  const executeRollback = () => {
    const productionEnvPath = resolve(repoRoot, options.productionEnvFile);
    const rollbackDigestPath = resolve(repoRoot, options.rollbackDigestFile);

    let productionEnvContent;
    let rollbackEnv;
    let rollbackCompatibility;
    try {
      if (!existsSync(productionEnvPath)) {
        throw new Error(`production env file not found: ${productionEnvPath}`);
      }
      productionEnvContent = readFileSync(productionEnvPath, "utf8");
      rollbackEnv = parseEnvFile(
        rollbackDigestPath,
        "rollback digest manifest",
      );
      validateRollbackImages(rollbackEnv);
      rollbackCompatibility = validateRollbackCompatibility(
        rollbackEnv,
        options,
        rollbackDigestPath,
        now(),
      );
    } catch (error) {
      return result(
        1,
        "",
        `Production compose rollback failed: ${redactProductionDeployTranscript(error instanceof Error ? error.message : String(error))}\n`,
      );
    }

    const tempDir = mkdtempSync(
      join(tmpdir(), "charitypilot-production-rollback-"),
    );
    const mergedEnvPath = join(tempDir, "rollback-production.env");
    const deployArgs = [
      "--production-env-file",
      mergedEnvPath,
      ...(options.waitTimeoutSeconds
        ? ["--wait-timeout", String(options.waitTimeoutSeconds)]
        : []),
      ...(options.backupOutputDir
        ? ["--backup-output-dir", options.backupOutputDir]
        : []),
      ...(options.dryRun ? ["--dry-run"] : []),
      ...(options.tlsProxy ? [] : ["--no-tls-proxy"]),
    ];

    try {
      writeFileSync(
        mergedEnvPath,
        mergedEnvContent(
          productionEnvContent,
          rollbackEnv,
          rollbackCompatibility.compatibility,
        ),
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );

      const deployResult = runDeploy(deployArgs, {
        processEnv,
        cutoverLock,
        attestedDatabaseCompatibility:
          rollbackCompatibility.compatibility === "pre-p006-restored"
            ? "pre-p006-restored"
            : null,
      });
      const stdoutPrefix = [
        `Production compose rollback${options.dryRun ? " dry-run" : ""}:`,
        `Rollback digest file: ${basename(options.rollbackDigestFile)}`,
        rollbackCompatibility.posture,
        "",
      ].join("\n");

      if (deployResult.status !== 0) {
        const delegatedStderr = redactProductionDeployTranscript(
          sanitizeDelegatedTranscript(deployResult.stderr, mergedEnvPath),
        );
        const recovery = delegatedStderr.includes(
          "Fail-closed runtime cleanup also failed",
        )
          ? `Rollback fail-closed cleanup needs operator action using the durable production env:\n${durableRecoveryCommand(options)}\n`
          : "";
        return result(
          deployResult.status,
          `${stdoutPrefix}${sanitizeDelegatedTranscript(deployResult.stdout, mergedEnvPath)}`,
          `Production compose rollback failed: deployment failed.\n${delegatedStderr}${recovery}`,
        );
      }

      return result(
        0,
        `${stdoutPrefix}${sanitizeDelegatedTranscript(deployResult.stdout, mergedEnvPath)}Production compose rollback completed.\n`,
        sanitizeDelegatedTranscript(deployResult.stderr, mergedEnvPath),
      );
    } catch (error) {
      return result(
        1,
        "",
        `Production compose rollback failed: ${redactProductionDeployTranscript(sanitizeDelegatedTranscript(error instanceof Error ? error.message : String(error), mergedEnvPath))}\n`,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  };

  let rollbackResult;
  let operationError;
  try {
    rollbackResult = executeRollback();
  } catch (error) {
    operationError = error;
  }

  try {
    releaseCutoverLock(cutoverLock);
  } catch (error) {
    const priorError = rollbackResult?.stderr
      ? `${rollbackResult.stderr.trimEnd()}\n`
      : operationError
        ? `Production compose rollback failed unexpectedly: ${redactProductionDeployTranscript(operationError instanceof Error ? operationError.message : String(operationError))}\n`
        : "";
    const releaseError = redactProductionDeployTranscript(
      error instanceof Error ? error.message : String(error),
    );
    return result(
      1,
      rollbackResult?.stdout ?? "",
      `${priorError}Production compose rollback could not release the host cutover lock: ${releaseError}. The prior rollback result is preserved above; do not start another deploy or rollback until the lock owner and runtime state are reconciled.\n`,
    );
  }

  if (operationError) throw operationError;
  return rollbackResult;
}

function main() {
  const rollbackResult = runProductionComposeRollbackFromArgs();
  if (rollbackResult.stdout) process.stdout.write(rollbackResult.stdout);
  if (rollbackResult.stderr) process.stderr.write(rollbackResult.stderr);
  process.exit(rollbackResult.status);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
