import {
  Prisma,
  PrismaClient,
  type BillingAuthorityGrantKind,
  type BillingAuthorityGrantReleaseReason,
  type BillingAuthorityGrantState,
} from '@prisma/client';
import { pathToFileURL } from 'node:url';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_SECRET_OR_URL = /(?:https?:\/\/|\b(?:sk|rk)_(?:live|test)_|\bwhsec_)/iu;

const EXPECTED_STATES = new Set<BillingAuthorityGrantState>([
  'CLAIMED',
  'PROVIDER_STARTED',
  'CAPABILITY_ISSUED',
]);
const RELEASE_REASONS = new Set<BillingAuthorityGrantReleaseReason>([
  'PROVIDER_CONFIRMED_NOT_ISSUED',
  'PROVIDER_CAPABILITY_REVOKED',
  'PROVIDER_CAPABILITY_TERMINAL',
  'CHECKOUT_SAFE_RELEASE_AFTER_ELAPSED',
  'RESTRICTED_OPERATOR_ATTESTATION',
]);

const VALUE_OPTIONS = new Set([
  '--organisation-id',
  '--grant-id',
  '--expected-state',
  '--reason',
  '--operator',
  '--case-reference',
  '--provider-evidence',
  '--confirm-release',
]);
const FLAG_OPTIONS = new Set([
  '--list',
  '--dry-run',
  '--release',
  '--confirm-authority-verified',
  '--confirm-billing-provider-io-quiesced',
]);

type ReconciliationInput = {
  organisationId: string;
  grantId: string;
  expectedState: Exclude<BillingAuthorityGrantState, 'RELEASED'>;
  reason: BillingAuthorityGrantReleaseReason;
  operator: string;
  caseReference: string;
  providerEvidence: string;
  authorityVerified: true;
  billingProviderIoQuiesced: boolean;
};

export type BillingAuthorityReconciliationCommand =
  | { mode: 'list' }
  | (ReconciliationInput & { mode: 'dry-run' })
  | (ReconciliationInput & { mode: 'release'; executionConfirmation: string });

type LockedOrganisation = {
  id: string;
  lifecycleStatus: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  lifecycleVersion: number;
};

type LockedBillingAuthorityGrant = {
  id: string;
  organisationId: string;
  kind: BillingAuthorityGrantKind;
  actorUserId: string;
  actorSessionId: string;
  actorMembershipVersion: number;
  state: BillingAuthorityGrantState;
  providerResourceId: string | null;
  safeReleaseAfter: Date | null;
  claimedAt: Date;
  providerStartedAt: Date | null;
  capabilityIssuedAt: Date | null;
  releasedAt: Date | null;
  releaseReason: BillingAuthorityGrantReleaseReason | null;
  releaseActor: string | null;
  releaseEvidence: Prisma.JsonValue | null;
};

type ReconciliationClient = Pick<PrismaClient, 'billingAuthorityGrant' | '$transaction'>;

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function boundedEvidence(value: string | undefined, name: string, maximum: number): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`${name} is required`);
  if (normalized.length > maximum) throw new Error(`${name} must be at most ${maximum} characters`);
  if (CONTROL_CHARACTERS.test(normalized)) throw new Error(`${name} must not contain control characters`);
  return normalized;
}

function normalizedEnum<T extends string>(
  value: string | undefined,
  name: string,
  allowed: ReadonlySet<T>,
): T {
  const normalized = boundedEvidence(value, name, 80).toUpperCase().replaceAll('-', '_') as T;
  if (!allowed.has(normalized)) {
    throw new Error(`${name} must be one of: ${[...allowed].join(', ')}`);
  }
  return normalized;
}

function requiresProviderIoQuiescence(
  expectedState: ReconciliationInput['expectedState'],
): boolean {
  return expectedState === 'CLAIMED' || expectedState === 'PROVIDER_STARTED';
}

function executionPhrase(
  command: Pick<
    ReconciliationInput,
    'grantId' | 'organisationId' | 'expectedState' | 'reason'
  >,
): string {
  const target = `RELEASE BILLING AUTHORITY ${command.grantId} FOR ${command.organisationId} FROM ${command.expectedState} AS ${command.reason}`;
  return requiresProviderIoQuiescence(command.expectedState)
    ? `${target} WITH BILLING PROVIDER IO QUIESCED`
    : target;
}

export function parseBillingAuthorityReconciliationArgs(
  args: string[],
): BillingAuthorityReconciliationCommand {
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

  const list = args.includes('--list');
  const dryRun = args.includes('--dry-run');
  const release = args.includes('--release');
  if (Number(list) + Number(dryRun) + Number(release) !== 1) {
    throw new Error('Choose exactly one mode: --list, --dry-run, or --release');
  }
  if (list) {
    if (args.length !== 1) throw new Error('--list does not accept release options');
    return { mode: 'list' };
  }

  if (!args.includes('--confirm-authority-verified')) {
    throw new Error('--confirm-authority-verified is required');
  }

  const organisationId = boundedEvidence(
    optionValue(args, '--organisation-id'),
    '--organisation-id',
    200,
  );
  const grantId = boundedEvidence(optionValue(args, '--grant-id'), '--grant-id', 36).toLowerCase();
  if (!UUID_PATTERN.test(grantId)) throw new Error('--grant-id must be a UUID');
  const expectedState = normalizedEnum(
    optionValue(args, '--expected-state'),
    '--expected-state',
    EXPECTED_STATES,
  ) as Exclude<BillingAuthorityGrantState, 'RELEASED'>;
  const reason = normalizedEnum(
    optionValue(args, '--reason'),
    '--reason',
    RELEASE_REASONS,
  );
  const providerEvidence = boundedEvidence(
    optionValue(args, '--provider-evidence'),
    '--provider-evidence',
    1000,
  );
  if (PROVIDER_SECRET_OR_URL.test(providerEvidence)) {
    throw new Error(
      '--provider-evidence must be a redacted provider finding or evidence-store reference, not a URL or secret',
    );
  }

  const billingProviderIoQuiesced = args.includes('--confirm-billing-provider-io-quiesced');
  if (requiresProviderIoQuiescence(expectedState) && !billingProviderIoQuiesced) {
    throw new Error(
      '--confirm-billing-provider-io-quiesced is required for CLAIMED or PROVIDER_STARTED; enter billing maintenance mode and drain provider I/O first',
    );
  }
  if (!requiresProviderIoQuiescence(expectedState) && billingProviderIoQuiesced) {
    throw new Error(
      '--confirm-billing-provider-io-quiesced only applies to CLAIMED or PROVIDER_STARTED',
    );
  }

  const common: ReconciliationInput = {
    organisationId,
    grantId,
    expectedState,
    reason,
    operator: boundedEvidence(optionValue(args, '--operator'), '--operator', 120),
    caseReference: boundedEvidence(optionValue(args, '--case-reference'), '--case-reference', 128),
    providerEvidence,
    authorityVerified: true,
    billingProviderIoQuiesced,
  };

  const suppliedConfirmation = optionValue(args, '--confirm-release')?.trim();
  if (dryRun) {
    if (args.includes('--confirm-release')) {
      throw new Error('--confirm-release must not be supplied with --dry-run');
    }
    return { mode: 'dry-run', ...common };
  }

  const expectedConfirmation = executionPhrase(common);
  if (suppliedConfirmation !== expectedConfirmation) {
    throw new Error(`--confirm-release must exactly equal "${expectedConfirmation}"`);
  }
  return {
    mode: 'release',
    ...common,
    executionConfirmation: suppliedConfirmation,
  };
}

function assertReasonAllowed(
  grant: LockedBillingAuthorityGrant,
  command: Exclude<BillingAuthorityReconciliationCommand, { mode: 'list' }>,
  now: Date,
): void {
  if (grant.kind === 'PORTAL') {
    if (command.reason !== 'RESTRICTED_OPERATOR_ATTESTATION') {
      throw new Error('Portal authority may only be released by RESTRICTED_OPERATOR_ATTESTATION');
    }
    return;
  }

  switch (command.reason) {
    case 'PROVIDER_CONFIRMED_NOT_ISSUED':
      if (grant.capabilityIssuedAt !== null || grant.providerResourceId !== null) {
        throw new Error(
          'PROVIDER_CONFIRMED_NOT_ISSUED requires no recorded capability or provider resource',
        );
      }
      return;
    case 'PROVIDER_CAPABILITY_REVOKED':
      if (grant.providerStartedAt === null || grant.providerResourceId === null) {
        throw new Error(
          'PROVIDER_CAPABILITY_REVOKED requires recorded provider-start and resource evidence',
        );
      }
      return;
    case 'PROVIDER_CAPABILITY_TERMINAL':
      if (grant.capabilityIssuedAt === null || grant.providerResourceId === null) {
        throw new Error(
          'PROVIDER_CAPABILITY_TERMINAL requires recorded capability-issued and resource evidence',
        );
      }
      return;
    case 'CHECKOUT_SAFE_RELEASE_AFTER_ELAPSED':
      if (
        grant.state !== 'CAPABILITY_ISSUED' ||
        grant.capabilityIssuedAt === null ||
        grant.providerResourceId === null ||
        grant.safeReleaseAfter === null ||
        grant.safeReleaseAfter.getTime() > now.getTime()
      ) {
        throw new Error(
          'CHECKOUT_SAFE_RELEASE_AFTER_ELAPSED requires an issued capability, provider resource, and elapsed recorded safe-release time',
        );
      }
      return;
    case 'RESTRICTED_OPERATOR_ATTESTATION':
      throw new Error(
        'Checkout authority requires concrete provider or elapsed-safe-time evidence; RESTRICTED_OPERATOR_ATTESTATION is Portal-only',
      );
  }
}

function releaseEvidence(
  organisation: LockedOrganisation,
  grant: LockedBillingAuthorityGrant,
  command: Exclude<BillingAuthorityReconciliationCommand, { mode: 'list' }>,
  now: Date,
): Prisma.InputJsonObject {
  return {
    schemaVersion: 1,
    basis: 'RESTRICTED_OFFLINE_BILLING_AUTHORITY_RECONCILIATION',
    grantId: grant.id,
    organisationId: organisation.id,
    organisationLifecycleStatus: organisation.lifecycleStatus,
    organisationLifecycleVersion: organisation.lifecycleVersion,
    grantKind: grant.kind,
    previousState: grant.state,
    releaseReason: command.reason,
    actorUserId: grant.actorUserId,
    actorSessionId: grant.actorSessionId,
    actorMembershipVersion: grant.actorMembershipVersion,
    providerResourceId: grant.providerResourceId,
    claimedAt: grant.claimedAt.toISOString(),
    providerStartedAt: grant.providerStartedAt?.toISOString() ?? null,
    capabilityIssuedAt: grant.capabilityIssuedAt?.toISOString() ?? null,
    safeReleaseAfter: grant.safeReleaseAfter?.toISOString() ?? null,
    releasedAt: now.toISOString(),
    operator: command.operator,
    caseReference: command.caseReference,
    providerEvidence: command.providerEvidence,
    authorityVerified: command.authorityVerified,
    billingProviderIoQuiesced: command.billingProviderIoQuiesced,
    providerIoQuiescenceRequired: requiresProviderIoQuiescence(command.expectedState),
    targetConfirmation: command.mode === 'release'
      ? command.executionConfirmation
      : executionPhrase(command),
  };
}

function reconciliationResult(
  organisation: LockedOrganisation,
  grant: LockedBillingAuthorityGrant,
  command: Exclude<BillingAuthorityReconciliationCommand, { mode: 'list' }>,
  now: Date,
) {
  return {
    mode: command.mode === 'release' ? 'RELEASED' as const : 'DRY_RUN' as const,
    mutationApplied: command.mode === 'release',
    organisationId: organisation.id,
    organisationLifecycleStatus: organisation.lifecycleStatus,
    organisationLifecycleVersion: organisation.lifecycleVersion,
    grantId: grant.id,
    grantKind: grant.kind,
    previousState: grant.state,
    releaseReason: command.reason,
    providerResourceId: grant.providerResourceId,
    safeReleaseAfter: grant.safeReleaseAfter?.toISOString() ?? null,
    operator: command.operator,
    caseReference: command.caseReference,
    providerEvidence: command.providerEvidence,
    authorityVerified: command.authorityVerified,
    billingProviderIoQuiesced: command.billingProviderIoQuiesced,
    providerIoQuiescenceRequired: requiresProviderIoQuiescence(command.expectedState),
    requiredReleaseConfirmation: executionPhrase(command),
    releasedAt: command.mode === 'release' ? now.toISOString() : null,
  };
}

function assertRuntimeCommand(
  command: Exclude<BillingAuthorityReconciliationCommand, { mode: 'list' }>,
): void {
  const canonicalValues: Array<[string, string, number]> = [
    [command.organisationId, '--organisation-id', 200],
    [command.grantId, '--grant-id', 36],
    [command.operator, '--operator', 120],
    [command.caseReference, '--case-reference', 128],
    [command.providerEvidence, '--provider-evidence', 1000],
  ];
  for (const [value, name, maximum] of canonicalValues) {
    if (boundedEvidence(value, name, maximum) !== value) {
      throw new Error(`Billing authority reconciliation refused: ${name} is not canonical`);
    }
  }
  if (!UUID_PATTERN.test(command.grantId) || command.grantId !== command.grantId.toLowerCase()) {
    throw new Error('Billing authority reconciliation refused: --grant-id is not a canonical UUID');
  }
  if (!EXPECTED_STATES.has(command.expectedState)) {
    throw new Error('Billing authority reconciliation refused: expected state is invalid');
  }
  if (!RELEASE_REASONS.has(command.reason)) {
    throw new Error('Billing authority reconciliation refused: release reason is invalid');
  }
  if (PROVIDER_SECRET_OR_URL.test(command.providerEvidence)) {
    throw new Error(
      'Billing authority reconciliation refused: provider evidence contains a URL or secret',
    );
  }
  if (command.authorityVerified !== true) {
    throw new Error('Billing authority reconciliation refused: operator authority is not verified');
  }
  if (
    requiresProviderIoQuiescence(command.expectedState) &&
    command.billingProviderIoQuiesced !== true
  ) {
    throw new Error(
      'Billing authority reconciliation refused: billing mutations and provider I/O are not attested quiescent',
    );
  }
  if (
    !requiresProviderIoQuiescence(command.expectedState) &&
    command.billingProviderIoQuiesced
  ) {
    throw new Error(
      'Billing authority reconciliation refused: provider-I/O quiescence attestation does not apply to this state',
    );
  }
  if (command.mode === 'release' && command.executionConfirmation !== executionPhrase(command)) {
    throw new Error('Billing authority reconciliation refused: target-bound confirmation is invalid');
  }
}

function assertRuntimeMode(command: BillingAuthorityReconciliationCommand): void {
  if (!command || typeof command !== 'object') {
    throw new Error('Billing authority reconciliation refused: command is required');
  }
  const candidate = command as unknown as Record<string, unknown>;
  if (!['list', 'dry-run', 'release'].includes(String(candidate.mode))) {
    throw new Error('Billing authority reconciliation refused: mode is invalid');
  }
  if (candidate.mode === 'list' && Object.keys(candidate).some((key) => key !== 'mode')) {
    throw new Error('Billing authority reconciliation refused: list mode accepts no release fields');
  }
}

export async function executeBillingAuthorityReconciliation(
  client: ReconciliationClient,
  command: BillingAuthorityReconciliationCommand,
  now = new Date(),
) {
  assertRuntimeMode(command);
  if (command.mode === 'list') {
    return client.billingAuthorityGrant.findMany({
      where: { state: { not: 'RELEASED' } },
      orderBy: [{ organisationId: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        organisationId: true,
        kind: true,
        state: true,
        actorUserId: true,
        actorSessionId: true,
        actorMembershipVersion: true,
        providerResourceId: true,
        claimedAt: true,
        providerStartedAt: true,
        capabilityIssuedAt: true,
        safeReleaseAfter: true,
      },
    });
  }
  assertRuntimeCommand(command);

  return client.$transaction(async (tx) => {
    const organisations = await tx.$queryRaw<LockedOrganisation[]>(Prisma.sql`
      SELECT "id", "lifecycleStatus", "lifecycleVersion"
      FROM "Organisation"
      WHERE "id" = ${command.organisationId}
      FOR UPDATE
    `);
    if (organisations.length !== 1) {
      throw new Error('Billing authority reconciliation refused: organisation not found');
    }
    const organisation = organisations[0];

    const grants = await tx.$queryRaw<LockedBillingAuthorityGrant[]>(Prisma.sql`
      SELECT
        "id", "organisationId", "kind", "actorUserId", "actorSessionId",
        "actorMembershipVersion", "state", "providerResourceId", "safeReleaseAfter",
        "claimedAt", "providerStartedAt", "capabilityIssuedAt", "releasedAt",
        "releaseReason", "releaseActor", "releaseEvidence"
      FROM "BillingAuthorityGrant"
      WHERE "id" = CAST(${command.grantId} AS UUID)
        AND "organisationId" = ${command.organisationId}
      FOR UPDATE
    `);
    if (grants.length !== 1) {
      throw new Error('Billing authority reconciliation refused: grant not found for this organisation');
    }
    const grant = grants[0];
    if (grant.state === 'RELEASED') {
      throw new Error('Billing authority reconciliation refused: grant is already released');
    }
    if (grant.state !== command.expectedState) {
      throw new Error(
        `Billing authority reconciliation refused: expected ${command.expectedState}, found ${grant.state}`,
      );
    }
    if (
      grant.releasedAt !== null ||
      grant.releaseReason !== null ||
      grant.releaseActor !== null ||
      grant.releaseEvidence !== null
    ) {
      throw new Error('Billing authority reconciliation refused: unresolved grant contains release evidence');
    }
    if (now.getTime() < grant.claimedAt.getTime()) {
      throw new Error('Billing authority reconciliation refused: release time precedes the grant claim');
    }
    assertReasonAllowed(grant, command, now);

    const result = reconciliationResult(organisation, grant, command, now);
    if (command.mode === 'dry-run') return result;

    const releaseActor = `RESTRICTED_OPERATOR:${command.operator}`;
    const released = await tx.billingAuthorityGrant.updateMany({
      where: {
        id: command.grantId,
        organisationId: command.organisationId,
        kind: grant.kind,
        state: command.expectedState,
        actorUserId: grant.actorUserId,
        actorSessionId: grant.actorSessionId,
        actorMembershipVersion: grant.actorMembershipVersion,
        releasedAt: null,
        releaseReason: null,
        releaseActor: null,
      },
      data: {
        state: 'RELEASED',
        releasedAt: now,
        releaseReason: command.reason,
        releaseActor,
        releaseEvidence: releaseEvidence(organisation, grant, command, now),
      },
    });
    if (released.count !== 1) {
      throw new Error('Billing authority reconciliation refused: grant changed concurrently');
    }
    return result;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 10_000,
  });
}

async function main() {
  const command = parseBillingAuthorityReconciliationArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    process.stderr.write(
      '[billing-authority-reconciliation] Restricted offline workflow. Keep provider, actor, organisation, and incident evidence out of shared logs.\n',
    );
    const result = await executeBillingAuthorityReconciliation(prisma, command);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[billing-authority-reconciliation] ${message}\n`);
    process.exitCode = 1;
  });
}
