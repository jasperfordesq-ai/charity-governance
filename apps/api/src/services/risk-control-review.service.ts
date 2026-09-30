import type { PrismaClient } from '@prisma/client';

type ReviewQueryClient = Pick<PrismaClient, '$queryRaw'>;

/** Counts claims needing renewed evidence review without reading evidence text. */
export class RiskControlReviewService {
  constructor(private readonly prisma: ReviewQueryClient) {}

  async countStaleClaims(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      WITH latest_claim AS (
        SELECT DISTINCT ON (v."organisationId", v."riskId", v."controlReference")
          v."organisationId", v."riskId", v."riskRevision", v."state"
        FROM "RiskControlVerification" v
        ORDER BY v."organisationId", v."riskId", v."controlReference", v."sequence" DESC
      )
      SELECT COUNT(*) AS "count"
      FROM latest_claim latest
      JOIN "RiskRecord" risk ON risk."id" = latest."riskId"
        AND risk."organisationId" = latest."organisationId"
      WHERE latest."state" = 'VERIFIED'
        AND latest."riskRevision" IS DISTINCT FROM risk."revision"
    `;
    const count = rows[0]?.count ?? 0n;
    if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Risk control review count exceeds safe integer range');
    }
    return Number(count);
  }
}
