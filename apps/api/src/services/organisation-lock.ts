import type { Prisma } from '@prisma/client';

export async function lockOrganisationForUpdate(
  transaction: Pick<Prisma.TransactionClient, '$queryRaw'>,
  organisationId: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT "id"
    FROM "Organisation"
    WHERE "id" = ${organisationId}
    FOR UPDATE
  `;
}
