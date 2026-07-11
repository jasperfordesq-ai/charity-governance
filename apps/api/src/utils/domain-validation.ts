import { ZodError } from 'zod';
import { AppError } from './errors.js';

const DOMAIN_INVARIANT_CONSTRAINTS = [
  'BoardMember_term_chronology_check',
  'BoardMember_conduct_signed_date_equivalence_check',
  'BoardMember_induction_date_equivalence_check',
  'FundraisingRecord_date_chronology_check',
  'AnnualReportReadiness_filed_date_required_check',
] as const;

const SAFE_CONSTRAINT_DETAILS = [
  {
    code: 'custom',
    path: [],
    message: 'The submitted governance facts are inconsistent',
  },
] as const;

const BOARD_MEMBER_CONFLICT_FOREIGN_KEY = 'ConflictRecord_boardMemberId_organisationId_fkey';

type DomainWriteErrorOptions = {
  boardMemberForeignKeyFailure?: 'target-not-found' | 'delete-conflict';
  recordNotFound?: {
    code: string;
    message: string;
  };
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function collectMetadataStrings(
  value: unknown,
  result: string[],
  seen: Set<object>,
  depth = 0,
): void {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') {
    result.push(value);
    return;
  }
  if (!isRecord(value) || seen.has(value)) return;

  seen.add(value);
  const nestedValues = Object.values(value);
  for (const key of [
    'code',
    'sqlState',
    'sqlstate',
    'constraint',
    'constraintName',
    'constraint_name',
    'meta',
    'cause',
    'driverAdapterError',
    'database_error',
    'originalCode',
    'originalMessage',
  ]) {
    if (key in value && !Object.prototype.propertyIsEnumerable.call(value, key)) {
      nestedValues.push(value[key]);
    }
  }
  for (const nested of nestedValues) {
    collectMetadataStrings(nested, result, seen, depth + 1);
  }
}

function metadataStrings(error: UnknownRecord): string[] {
  const values: string[] = [];
  const metadata = {
    code: error.code,
    sqlState: error.sqlState,
    sqlstate: error.sqlstate,
    constraint: error.constraint,
    constraintName: error.constraintName,
    constraint_name: error.constraint_name,
    meta: error.meta,
    cause: error.cause,
  };
  collectMetadataStrings(metadata, values, new Set());
  return values;
}

function metadataMentionsExactName(values: string[], name: string): boolean {
  const exactName = new RegExp(`(^|[^A-Za-z0-9_])${name}($|[^A-Za-z0-9_])`);
  return values.some((metadataValue) => exactName.test(metadataValue));
}

function prismaConnectorErrorMessage(error: UnknownRecord, sqlState: '23503' | '23514'): string | null {
  if (
    error.name !== 'PrismaClientUnknownRequestError' ||
    typeof error.message !== 'string' ||
    !error.message.includes(`PostgresError { code: "${sqlState}"`)
  ) {
    return null;
  }
  return error.message;
}

function domainConstraintName(error: unknown): string | null {
  if (!isRecord(error)) return null;

  const values = metadataStrings(error);
  const connectorMessage = prismaConnectorErrorMessage(error, '23514');

  const isPrismaCheckError = values.includes('P2004');
  const isPostgresCheckError = values.includes('23514');
  if (!isPrismaCheckError && !isPostgresCheckError && !connectorMessage) return null;

  const constraintEvidence = connectorMessage ? [...values, connectorMessage] : values;

  return DOMAIN_INVARIANT_CONSTRAINTS.find((constraint) =>
    metadataMentionsExactName(constraintEvidence, constraint),
  ) ?? null;
}

function isBoardMemberConflictForeignKeyError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const values = metadataStrings(error);
  const connectorMessage = prismaConnectorErrorMessage(error, '23503');
  const isForeignKeyError = values.includes('P2003') || connectorMessage !== null;
  const constraintEvidence = connectorMessage ? [...values, connectorMessage] : values;
  return isForeignKeyError && metadataMentionsExactName(constraintEvidence, BOARD_MEMBER_CONFLICT_FOREIGN_KEY);
}

export function validateDomainCompleteState<T>(
  validator: (value: unknown) => T,
  value: unknown,
): T {
  try {
    return validator(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', error.issues);
    }
    throw error;
  }
}

export async function runDomainInvariantWrite<T>(
  operation: () => Promise<T>,
  options: DomainWriteErrorOptions = {},
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (domainConstraintName(error)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', SAFE_CONSTRAINT_DETAILS);
    }
    if (options.boardMemberForeignKeyFailure && isBoardMemberConflictForeignKeyError(error)) {
      if (options.boardMemberForeignKeyFailure === 'target-not-found') {
        throw new AppError(404, 'BOARD_MEMBER_NOT_FOUND', 'Board member not found');
      }
      throw new AppError(
        409,
        'BOARD_MEMBER_STATE_CONFLICT',
        'This board member changed while its conflict references were being updated. Refresh and try again.',
      );
    }
    if (options.recordNotFound && isRecord(error) && error.code === 'P2025') {
      throw new AppError(404, options.recordNotFound.code, options.recordNotFound.message);
    }
    throw error;
  }
}
