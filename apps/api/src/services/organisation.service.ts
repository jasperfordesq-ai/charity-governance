import type { PrismaClient } from '@prisma/client';
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
    const org = await this.prisma.organisation.update({
      where: { id: organisationId },
      data: {
        ...data,
        financialYearEnd: data.financialYearEnd ? new Date(data.financialYearEnd) : data.financialYearEnd,
        dateRegistered: data.dateRegistered ? new Date(data.dateRegistered) : data.dateRegistered,
        lastAgmDate: data.lastAgmDate ? new Date(data.lastAgmDate) : data.lastAgmDate,
      },
      select: publicOrganisationSelect,
    });

    if (data.financialYearEnd !== undefined || data.lastAgmDate !== undefined) {
      await new DeadlineService(this.prisma).generateAutoDeadlines(organisationId);
    }

    return publicOrganisation(org);
  }
}
