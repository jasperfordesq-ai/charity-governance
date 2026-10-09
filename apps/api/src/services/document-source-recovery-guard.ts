import type { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { lockOrganisationForUpdate } from './organisation-lock.js';

/** Serialize ordinary source writes with the recovery-binding insert. */
export async function assertDocumentSourceUnbound(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | 'documentRecoveryEnforcement'>,
  organisationId: string,
): Promise<void> {
  await lockOrganisationForUpdate(tx, organisationId);
  if (await tx.documentRecoveryEnforcement.findUnique({
    where: { organisationId }, select: { id: true },
  })) {
    throw new AppError(409, 'DOCUMENT_SOURCE_RECOVERY_REQUIRED',
      'Document source changes require independent recovery authority for this charity.');
  }
}
