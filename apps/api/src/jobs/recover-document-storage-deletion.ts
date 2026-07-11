import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isAbsolute, normalize, sep } from 'node:path';
import {
  DocumentService,
  type DocumentStorageDeletionRecoveryDisposition,
} from '../services/document.service.js';
import { assertOrganisationStoragePath } from '../services/storage.service.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const IDENTIFIER = /^[A-Za-z0-9_-]+$/u;
const VALUE_OPTIONS = new Set([
  '--organisation-id',
  '--deletion-id',
  '--operator',
  '--reason',
  '--disposition',
  '--corrected-storage-path',
  '--expected-attempts',
  '--expected-terminal-reason',
  '--expected-database-authority-sha256',
  '--expected-corrected-storage-path-sha256',
  '--confirm-execute',
]);
const FLAG_OPTIONS = new Set(['--dry-run', '--execute', '--confirm-production-database-authority']);
const DISPOSITIONS = new Set<DocumentStorageDeletionRecoveryDisposition>([
  'REQUEUE_UNCHANGED',
  'REQUEUE_CORRECTED_PATH',
  'COMPLETE_EXTERNALLY_REMEDIATED',
]);
const TERMINAL_REASONS = new Set([
  'MAX_ATTEMPTS_EXHAUSTED',
  'PERMANENT_STORAGE_PATH_REJECTED',
] as const);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ALLOWED_DATABASE_QUERY_OPTIONS = new Set([
  'application_name',
  'channel_binding',
  'connect_timeout',
  'keepalives',
  'keepalives_count',
  'keepalives_idle',
  'keepalives_interval',
  'sslmode',
  'sslrootcert',
  'target_session_attrs',
  'tcp_user_timeout',
]);

type TerminalReason = 'MAX_ATTEMPTS_EXHAUSTED' | 'PERMANENT_STORAGE_PATH_REJECTED';

export type PlatformDocumentStorageRecoveryCommand = {
  mode: 'dry-run' | 'execute';
  organisationId: string;
  deletionId: string;
  operatorIdentity: string;
  reason: string;
  disposition: DocumentStorageDeletionRecoveryDisposition;
  correctedStoragePath?: string;
  expectedAttempts?: number;
  expectedTerminalReason?: TerminalReason;
  expectedDatabaseAuthoritySha256?: string;
  expectedCorrectedStoragePathSha256?: string;
  productionDatabaseAuthorityConfirmed: true;
  executionConfirmation?: string;
};

type PlatformRecoveryDatabase = Pick<
  PrismaClient,
  'documentStorageDeletion' | '$transaction'
>;

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function bounded(value: string | undefined, name: string, minimum: number, maximum: number): string {
  const normalized = value?.replace(/\r\n?/g, '\n').trim() ?? '';
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new Error(`${name} must contain between ${minimum} and ${maximum} characters`);
  }
  if (CONTROL_CHARACTERS.test(normalized)) throw new Error(`${name} contains unsupported control characters`);
  return normalized;
}

function identifier(value: string | undefined, name: string): string {
  const normalized = bounded(value, name, 1, 200);
  if (!IDENTIFIER.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function namedOperator(value: string | undefined): string {
  const operator = bounded(value, '--operator', 3, 160);
  if (
    /[@:\\/]/u.test(operator) ||
    /^(?:admin|administrator|operator|system|unknown)$/iu.test(operator)
  ) {
    throw new Error('--operator must be a safe named human operator identity');
  }
  return operator;
}

function positiveAttempts(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error('--expected-attempts must be a positive integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('--expected-attempts must be a safe positive integer');
  return parsed;
}

export function platformDocumentRecoveryConfirmation(input: {
  organisationId: string;
  deletionId: string;
  disposition: DocumentStorageDeletionRecoveryDisposition;
  expectedAttempts: number;
  expectedTerminalReason: TerminalReason;
  databaseAuthoritySha256: string;
  correctedStoragePathSha256: string | null;
}): string {
  return `RECOVER DOCUMENT STORAGE DELETION ${input.deletionId} FOR ${input.organisationId} AT ATTEMPTS ${input.expectedAttempts} REASON ${input.expectedTerminalReason} AS ${input.disposition} DATABASE AUTHORITY SHA256 ${input.databaseAuthoritySha256} CORRECTED PATH SHA256 ${input.correctedStoragePathSha256 ?? 'NONE'}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function optionalSha256(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return normalized;
}

export function parsePlatformDocumentStorageRecoveryArgs(args: string[]): PlatformDocumentStorageRecoveryCommand {
  const allowed = new Set([...VALUE_OPTIONS, ...FLAG_OPTIONS]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowed.has(argument)) throw new Error(`Unknown option: ${argument}`);
    if (VALUE_OPTIONS.has(argument)) index += 1;
  }
  for (const option of allowed) {
    if (args.filter((argument) => argument === option).length > 1) {
      throw new Error(`${option} may only be supplied once`);
    }
  }

  const dryRun = args.includes('--dry-run');
  const execute = args.includes('--execute');
  if (Number(dryRun) + Number(execute) !== 1) {
    throw new Error('Choose exactly one mode: --dry-run or --execute');
  }
  if (!args.includes('--confirm-production-database-authority')) {
    throw new Error('--confirm-production-database-authority is required');
  }

  const organisationId = identifier(optionValue(args, '--organisation-id'), '--organisation-id');
  const deletionId = identifier(optionValue(args, '--deletion-id'), '--deletion-id');
  const disposition = bounded(optionValue(args, '--disposition'), '--disposition', 1, 80) as DocumentStorageDeletionRecoveryDisposition;
  if (!DISPOSITIONS.has(disposition)) throw new Error('--disposition is invalid');

  const correctedStoragePath = optionValue(args, '--corrected-storage-path')?.trim();
  if (disposition === 'REQUEUE_CORRECTED_PATH') {
    if (!correctedStoragePath) throw new Error('--corrected-storage-path is required for corrected-path recovery');
    assertOrganisationStoragePath(organisationId, correctedStoragePath);
  } else if (correctedStoragePath !== undefined) {
    throw new Error('--corrected-storage-path is only valid for corrected-path recovery');
  }

  const expectedAttempts = positiveAttempts(optionValue(args, '--expected-attempts'));
  const expectedTerminalReasonValue = optionValue(args, '--expected-terminal-reason');
  const expectedTerminalReason = expectedTerminalReasonValue as TerminalReason | undefined;
  if (expectedTerminalReason !== undefined && !TERMINAL_REASONS.has(expectedTerminalReason)) {
    throw new Error('--expected-terminal-reason is invalid');
  }
  if (execute && (expectedAttempts === undefined || expectedTerminalReason === undefined)) {
    throw new Error('--execute requires the attempts and terminal reason from the reviewed dry-run');
  }
  const expectedDatabaseAuthoritySha256 = optionalSha256(
    optionValue(args, '--expected-database-authority-sha256'),
    '--expected-database-authority-sha256',
  );
  const expectedCorrectedStoragePathSha256 = optionalSha256(
    optionValue(args, '--expected-corrected-storage-path-sha256'),
    '--expected-corrected-storage-path-sha256',
  );
  if (execute && expectedDatabaseAuthoritySha256 === undefined) {
    throw new Error('--execute requires --expected-database-authority-sha256 from the reviewed dry-run');
  }
  if (execute && disposition === 'REQUEUE_CORRECTED_PATH' && expectedCorrectedStoragePathSha256 === undefined) {
    throw new Error('--execute corrected-path recovery requires --expected-corrected-storage-path-sha256 from the reviewed dry-run');
  }
  if (disposition !== 'REQUEUE_CORRECTED_PATH' && expectedCorrectedStoragePathSha256 !== undefined) {
    throw new Error('--expected-corrected-storage-path-sha256 is only valid for corrected-path recovery');
  }

  const executionConfirmation = optionValue(args, '--confirm-execute')?.trim();
  if (dryRun && executionConfirmation !== undefined) {
    throw new Error('--confirm-execute is execution-only');
  }
  if (execute) {
    const expectedConfirmation = platformDocumentRecoveryConfirmation({
      organisationId,
      deletionId,
      disposition,
      expectedAttempts: expectedAttempts as number,
      expectedTerminalReason: expectedTerminalReason as TerminalReason,
      databaseAuthoritySha256: expectedDatabaseAuthoritySha256 as string,
      correctedStoragePathSha256: expectedCorrectedStoragePathSha256 ?? null,
    });
    if (executionConfirmation !== expectedConfirmation) {
      throw new Error(`--confirm-execute must exactly match the reviewed target-bound confirmation`);
    }
  }

  return {
    mode: dryRun ? 'dry-run' : 'execute',
    organisationId,
    deletionId,
    operatorIdentity: namedOperator(optionValue(args, '--operator')),
    reason: bounded(optionValue(args, '--reason'), '--reason', 10, 500),
    disposition,
    correctedStoragePath,
    expectedAttempts,
    expectedTerminalReason,
    expectedDatabaseAuthoritySha256,
    expectedCorrectedStoragePathSha256,
    productionDatabaseAuthorityConfirmed: true,
    executionConfirmation,
  };
}

function assertProductionDatabaseAuthority(
  command: PlatformDocumentStorageRecoveryCommand,
  env: Record<string, string | undefined>,
): string {
  if (command.productionDatabaseAuthorityConfirmed !== true) {
    throw new Error('Document storage recovery refused: production database authority is unconfirmed');
  }
  if (env.NODE_ENV !== 'production') {
    throw new Error('Document storage recovery refused: NODE_ENV must be production');
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Document storage recovery refused: DATABASE_URL is required');
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('Document storage recovery refused: DATABASE_URL is invalid');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('Document storage recovery refused: DATABASE_URL must use PostgreSQL');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  const reservedName =
    hostname === 'localhost' ||
    hostname === 'host.docker.internal' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.private') ||
    hostname.endsWith('.example') ||
    hostname.endsWith('.example.com') ||
    hostname.endsWith('.example.net') ||
    hostname.endsWith('.example.org') ||
    hostname.endsWith('.test') ||
    hostname.endsWith('.invalid') ||
    ['example.com', 'example.net', 'example.org'].includes(hostname);
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname)?.slice(1).map(Number);
  const isPrivateIpv4 = (parts: number[] | undefined) => Boolean(parts && (
    parts.some((part) => part > 255) ||
    parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && [0, 2, 168].includes(parts[1])) ||
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || parts[1] === 51)) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) ||
    parts[0] >= 224
  ));
  const privateIpv4 = isPrivateIpv4(ipv4);
  const mappedIpv4Text = hostname.startsWith('::ffff:') ? hostname.slice('::ffff:'.length) : undefined;
  const mappedIpv4 = mappedIpv4Text
    ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(mappedIpv4Text)?.slice(1).map(Number)
    : undefined;
  const privateIpv6 = hostname === '::1' || hostname === '::' ||
    /^(?:fc|fd|fe8|fe9|fea|feb)/iu.test(hostname) || isPrivateIpv4(mappedIpv4);
  if (!hostname || reservedName || privateIpv4 || privateIpv6) {
    throw new Error('Document storage recovery refused: DATABASE_URL host is not an approved remote production authority');
  }
  if (!parsed.username || !parsed.pathname || parsed.pathname === '/' || parsed.hash) {
    throw new Error('Document storage recovery refused: DATABASE_URL authority is incomplete');
  }

  const hostAllowlist = (env.DOCUMENT_STORAGE_RECOVERY_DATABASE_HOST_ALLOWLIST ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase().replace(/\.$/u, ''))
    .filter(Boolean);
  if (hostAllowlist.length === 0 || new Set(hostAllowlist).size !== hostAllowlist.length || !hostAllowlist.includes(hostname)) {
    throw new Error('Document storage recovery refused: DATABASE_URL host is not in the explicit recovery allowlist');
  }

  const seenOptions = new Set<string>();
  for (const [rawName, value] of parsed.searchParams) {
    const name = rawName.toLowerCase();
    if (rawName !== name || seenOptions.has(name) || !ALLOWED_DATABASE_QUERY_OPTIONS.has(name)) {
      throw new Error('Document storage recovery refused: DATABASE_URL contains unsupported or ambiguous connection options');
    }
    seenOptions.add(name);
    if (name === 'channel_binding' && value !== 'require') {
      throw new Error('Document storage recovery refused: DATABASE_URL channel_binding is invalid');
    }
    if (name === 'sslrootcert') {
      const normalizedCertificatePath = normalize(value);
      if (
        value === 'system' ||
        value.length > 1024 ||
        !isAbsolute(value) ||
        normalizedCertificatePath !== value ||
        value.split(/[\\/]/u).includes('..') ||
        !/\.(?:crt|pem)$/iu.test(value) ||
        (sep === '\\' && !/^[A-Za-z]:\\/u.test(value))
      ) {
        throw new Error('Document storage recovery refused: DATABASE_URL sslrootcert must be an explicit safe absolute CA certificate path');
      }
    }
    if (name === 'target_session_attrs' && value !== 'read-write') {
      throw new Error('Document storage recovery refused: DATABASE_URL must target a read-write server');
    }
    if (name === 'keepalives' && value !== '0' && value !== '1') {
      throw new Error('Document storage recovery refused: DATABASE_URL keepalives is invalid');
    }
    if (
      ['connect_timeout', 'keepalives_count', 'keepalives_idle', 'keepalives_interval', 'tcp_user_timeout'].includes(name) &&
      !/^(?:0|[1-9][0-9]{0,5})$/u.test(value)
    ) {
      throw new Error('Document storage recovery refused: DATABASE_URL numeric connection option is invalid');
    }
    if (name === 'application_name' && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(value)) {
      throw new Error('Document storage recovery refused: DATABASE_URL application_name is invalid');
    }
  }
  if (parsed.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('Document storage recovery refused: DATABASE_URL must use verify-full authenticated TLS');
  }
  if (parsed.searchParams.get('target_session_attrs') !== 'read-write') {
    throw new Error('Document storage recovery refused: DATABASE_URL must explicitly target a read-write server');
  }
  return sha256(databaseUrl.trim());
}

function assertPlatformRecoveryCommand(command: PlatformDocumentStorageRecoveryCommand): void {
  if (command.mode !== 'dry-run' && command.mode !== 'execute') {
    throw new Error('Document storage recovery refused: command mode is invalid');
  }
  if (identifier(command.organisationId, 'organisationId') !== command.organisationId ||
      identifier(command.deletionId, 'deletionId') !== command.deletionId) {
    throw new Error('Document storage recovery refused: command identifiers are not canonical');
  }
  if (namedOperator(command.operatorIdentity) !== command.operatorIdentity) {
    throw new Error('Document storage recovery refused: operator identity is not canonical');
  }
  if (bounded(command.reason, 'reason', 10, 500) !== command.reason || !DISPOSITIONS.has(command.disposition)) {
    throw new Error('Document storage recovery refused: recovery evidence is invalid');
  }
  if (command.disposition === 'REQUEUE_CORRECTED_PATH') {
    if (!command.correctedStoragePath) {
      throw new Error('Document storage recovery refused: corrected path is required');
    }
    assertOrganisationStoragePath(command.organisationId, command.correctedStoragePath);
  } else if (command.correctedStoragePath !== undefined) {
    throw new Error('Document storage recovery refused: corrected path is not allowed for this disposition');
  }
  if (command.mode === 'dry-run' && command.executionConfirmation !== undefined) {
    throw new Error('Document storage recovery refused: dry-run cannot contain execute confirmation');
  }
  if (command.mode === 'execute' &&
      (command.expectedAttempts === undefined ||
       command.expectedTerminalReason === undefined ||
       command.expectedDatabaseAuthoritySha256 === undefined)) {
    throw new Error('Document storage recovery refused: execute requires reviewed dead-letter evidence');
  }
  if (command.mode === 'execute' && command.disposition === 'REQUEUE_CORRECTED_PATH' &&
      command.expectedCorrectedStoragePathSha256 === undefined) {
    throw new Error('Document storage recovery refused: execute requires the reviewed corrected-path digest');
  }
}

export async function runPlatformDocumentStorageRecovery(
  command: PlatformDocumentStorageRecoveryCommand,
  prisma: PlatformRecoveryDatabase,
  env: Record<string, string | undefined> = process.env,
) {
  const databaseAuthoritySha256 = assertProductionDatabaseAuthority(command, env);
  assertPlatformRecoveryCommand(command);
  const correctedStoragePathSha256 = command.correctedStoragePath
    ? sha256(command.correctedStoragePath)
    : null;
  if (command.mode === 'execute' && command.expectedDatabaseAuthoritySha256 !== databaseAuthoritySha256) {
    throw new Error('Document storage recovery refused: database authority changed after dry-run');
  }
  if (
    command.mode === 'execute' &&
    command.disposition === 'REQUEUE_CORRECTED_PATH' &&
    command.expectedCorrectedStoragePathSha256 !== correctedStoragePathSha256
  ) {
    throw new Error('Document storage recovery refused: corrected storage path changed after dry-run');
  }
  const deletion = await prisma.documentStorageDeletion.findFirst({
    where: {
      id: command.deletionId,
      organisationId: command.organisationId,
      state: 'DEAD_LETTER',
    },
    select: {
      id: true,
      attempts: true,
      terminalReason: true,
      deadLetteredAt: true,
      alertedAt: true,
    },
  });
  if (!deletion || !deletion.terminalReason) {
    throw new Error('Document storage recovery refused: tenant-scoped dead letter was not found');
  }

  const preview = {
    mode: command.mode === 'dry-run' ? 'DRY_RUN' as const : 'EXECUTED' as const,
    mutationApplied: command.mode === 'execute',
    organisationId: command.organisationId,
    deletionId: deletion.id,
    attempts: deletion.attempts,
    terminalReason: deletion.terminalReason,
    disposition: command.disposition,
    deadLetteredAt: deletion.deadLetteredAt,
    alertedAt: deletion.alertedAt,
    databaseAuthoritySha256,
    correctedStoragePathSha256,
  };
  if (command.mode === 'dry-run') {
    return {
      ...preview,
      requiredExecutionConfirmation: platformDocumentRecoveryConfirmation({
        organisationId: command.organisationId,
        deletionId: deletion.id,
        disposition: command.disposition,
        expectedAttempts: deletion.attempts,
        expectedTerminalReason: deletion.terminalReason,
        databaseAuthoritySha256,
        correctedStoragePathSha256,
      }),
    };
  }
  if (
    command.expectedAttempts !== deletion.attempts ||
    command.expectedTerminalReason !== deletion.terminalReason
  ) {
    throw new Error('Document storage recovery refused: reviewed dead-letter evidence changed');
  }
  const expectedConfirmation = platformDocumentRecoveryConfirmation({
    organisationId: command.organisationId,
    deletionId: deletion.id,
    disposition: command.disposition,
    expectedAttempts: deletion.attempts,
    expectedTerminalReason: deletion.terminalReason,
    databaseAuthoritySha256,
    correctedStoragePathSha256,
  });
  if (command.executionConfirmation !== expectedConfirmation) {
    throw new Error('Document storage recovery refused: execute confirmation does not match the reviewed target');
  }

  const service = new DocumentService(prisma as PrismaClient);
  const result = await service.recoverDeadLetterStorageDeletion({
    organisationId: command.organisationId,
    deletionId: command.deletionId,
    actor: { actorType: 'PLATFORM_OPERATOR', operatorIdentity: command.operatorIdentity },
    reason: command.reason,
    disposition: command.disposition,
    correctedStoragePath: command.correctedStoragePath,
    expectedAttempts: command.expectedAttempts,
    expectedTerminalReason: command.expectedTerminalReason,
  });
  return { ...preview, status: result.status };
}

async function main(): Promise<void> {
  const command = parsePlatformDocumentStorageRecoveryArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const result = await runPlatformDocumentStorageRecovery(command, prisma);
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const candidateCode = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    const code = typeof candidateCode === 'string' && /^[A-Z0-9_]{3,80}$/u.test(candidateCode)
      ? candidateCode
      : 'DOCUMENT_STORAGE_RECOVERY_FAILED';
    console.error(JSON.stringify({ ok: false, code }));
    process.exitCode = 1;
  }
}
