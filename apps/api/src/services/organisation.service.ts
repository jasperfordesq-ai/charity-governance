import { Prisma, type PrismaClient } from '@prisma/client';
import type { UpdateOrganisationRequest } from '@charitypilot/shared';
import { AppError } from '../utils/errors.js';
import { DeadlineService } from './deadline.service.js';
import { publicOrganisation, publicOrganisationSelect } from '../utils/public-dtos.js';

export class OrganisationService {
  constructor(private prisma: PrismaClient) {}

  async getOrganisation(organisationId: string) {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: publicOrganisationSelect,
    });

    if (!org) {
      throw new AppError(404, 'ORG_NOT_FOUND', 'Organisation not found');
    }

    return publicOrganisation(org);
  }

  async updateOrganisation(organisationId: string, data: UpdateOrganisationRequest) {
    const shouldRegenerateDeadlines = data.financialYearEnd !== undefined || data.lastAgmDate !== undefined;
    const {
      financialYearEnd,
      dateRegistered,
      lastAgmDate,
      conditionalObligationProfile,
      ...profileData
    } = data;
    const updateData: Prisma.OrganisationUpdateInput = { ...profileData };
    if (financialYearEnd !== undefined) {
      updateData.financialYearEnd = financialYearEnd ? new Date(financialYearEnd) : null;
    }
    if (dateRegistered !== undefined) {
      updateData.dateRegistered = dateRegistered ? new Date(dateRegistered) : null;
    }
    if (lastAgmDate !== undefined) {
      updateData.lastAgmDate = lastAgmDate ? new Date(lastAgmDate) : null;
    }
    if (conditionalObligationProfile !== undefined) {
      updateData.conditionalObligationProfile =
        conditionalObligationProfile === null
          ? Prisma.JsonNull
          : { ...conditionalObligationProfile } satisfies Prisma.InputJsonObject;
    }

    const org = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.organisation.update({
        where: { id: organisationId },
        data: updateData,
        select: publicOrganisationSelect,
      });

      if (shouldRegenerateDeadlines) {
        await new DeadlineService(tx).generateAutoDeadlines(organisationId);
      }

      return updated;
    });

    return publicOrganisation(org);
  }
}
