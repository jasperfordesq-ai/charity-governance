import { Prisma, type PrismaClient } from '@prisma/client';
import {
  compareCivilDates,
  todayInTimeZone,
  type UpdateOrganisationRequest,
} from '@charitypilot/shared';
import { AppError } from '../utils/errors.js';
import { DeadlineService } from './deadline.service.js';
import { publicOrganisation, publicOrganisationSelect } from '../utils/public-dtos.js';
import { nullableCivilDateFromPrisma, prismaDateFromCivil } from '../utils/civil-date.js';

const CALENDAR_UPDATE_FIELDS = [
  'financialYearEnd',
  'legalForm',
  'confirmLegalForm',
  'incorporationDate',
  'croAnnualReturnDate',
  'confirmCroAnnualReturnDate',
  'lastActualAgmDate',
  'lastUnanimousAnnualMemberResolutionDate',
  'memberCount',
] as const;

function isRetryableTransactionConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2034');
}

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
    const shouldRegenerateDeadlines = CALENDAR_UPDATE_FIELDS.some((field) => data[field] !== undefined);
    const {
      expectedUpdatedAt,
      financialYearEnd,
      dateRegistered,
      incorporationDate,
      croAnnualReturnDate,
      lastActualAgmDate,
      lastUnanimousAnnualMemberResolutionDate,
      conditionalObligationProfile,
      confirmLegalForm,
      confirmCroAnnualReturnDate,
      legalForm,
      ...profileData
    } = data;
    const expectedUpdatedAtInstant = new Date(expectedUpdatedAt);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const org = await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${organisationId} FOR UPDATE`;
          const current = await tx.organisation.findUnique({
            where: { id: organisationId },
            select: {
              legalForm: true,
              legalFormConfirmedAt: true,
              financialYearEnd: true,
              croAnnualReturnDate: true,
              croAnnualReturnDateConfirmedAt: true,
              incorporationDate: true,
              lastActualAgmDate: true,
              lastUnanimousAnnualMemberResolutionDate: true,
              updatedAt: true,
            },
          });
          if (!current) {
            throw new AppError(404, 'ORG_NOT_FOUND', 'Organisation not found');
          }
          if (current.updatedAt.getTime() !== expectedUpdatedAtInstant.getTime()) {
            throw new AppError(
              409,
              'ORGANISATION_UPDATE_CONFLICT',
              'The organisation profile changed since it was loaded. Refresh and review the latest values.',
            );
          }

          if (shouldRegenerateDeadlines) {
            const effectiveLegalForm = legalForm !== undefined ? legalForm : current.legalForm;
            const effectiveFinancialYearEnd = financialYearEnd !== undefined
              ? financialYearEnd
              : nullableCivilDateFromPrisma(current.financialYearEnd);
            const effectiveIncorporationDate = incorporationDate !== undefined
              ? incorporationDate
              : nullableCivilDateFromPrisma(current.incorporationDate);
            const effectiveCroAnnualReturnDate = croAnnualReturnDate !== undefined
              ? croAnnualReturnDate
              : nullableCivilDateFromPrisma(current.croAnnualReturnDate);
            const effectiveLastActualAgmDate = lastActualAgmDate !== undefined
              ? lastActualAgmDate
              : nullableCivilDateFromPrisma(current.lastActualAgmDate);
            const effectiveLastResolutionDate = lastUnanimousAnnualMemberResolutionDate !== undefined
              ? lastUnanimousAnnualMemberResolutionDate
              : nullableCivilDateFromPrisma(current.lastUnanimousAnnualMemberResolutionDate);
            const today = todayInTimeZone('Europe/Dublin');

            for (const [value, label] of [
              [effectiveFinancialYearEnd, 'Financial year end'],
              [effectiveIncorporationDate, 'Incorporation date'],
              [effectiveCroAnnualReturnDate, 'CRO Annual Return Date'],
              [effectiveLastActualAgmDate, 'Last actual AGM date'],
              [effectiveLastResolutionDate, 'Written-resolution date'],
            ] as const) {
              if (value && compareCivilDates(value, '9997-12-31') > 0) {
                throw new AppError(
                  400,
                  'LEGAL_CALENDAR_DATE_OUT_OF_RANGE',
                  `${label} exceeds the supported legal calendar range.`,
                );
              }
            }

            if (confirmLegalForm === true && !effectiveLegalForm) {
              throw new AppError(400, 'LEGAL_FORM_REQUIRED', 'Choose a legal form before confirming it.');
            }
            if (confirmCroAnnualReturnDate === true && !effectiveCroAnnualReturnDate) {
              throw new AppError(
                400,
                'CRO_ARD_REQUIRED',
                'Enter the annual return date from CORE before confirming it.',
              );
            }
            for (const [value, code, label] of [
              [effectiveIncorporationDate, 'INCORPORATION_DATE_IN_FUTURE', 'Incorporation date'],
              [effectiveLastActualAgmDate, 'ACTUAL_AGM_DATE_IN_FUTURE', 'Last actual AGM date'],
              [effectiveLastResolutionDate, 'MEMBER_RESOLUTION_DATE_IN_FUTURE', 'Written-resolution date'],
            ] as const) {
              if (value && compareCivilDates(value, today) > 0) {
                throw new AppError(400, code, `${label} cannot be in the future.`);
              }
            }
            for (const [value, code, label] of [
              [effectiveLastActualAgmDate, 'ACTUAL_AGM_BEFORE_INCORPORATION', 'Last actual AGM date'],
              [effectiveLastResolutionDate, 'MEMBER_RESOLUTION_BEFORE_INCORPORATION', 'Written-resolution date'],
              [effectiveCroAnnualReturnDate, 'CRO_ARD_BEFORE_INCORPORATION', 'CRO Annual Return Date'],
            ] as const) {
              if (
                effectiveIncorporationDate &&
                value &&
                compareCivilDates(value, effectiveIncorporationDate) < 0
              ) {
                throw new AppError(400, code, `${label} cannot be before the incorporation date.`);
              }
            }
          }

          const updateData: Prisma.OrganisationUpdateInput = { ...profileData };
          if (financialYearEnd !== undefined) {
            updateData.financialYearEnd = financialYearEnd ? prismaDateFromCivil(financialYearEnd) : null;
          }
          if (dateRegistered !== undefined) {
            updateData.dateRegistered = dateRegistered ? prismaDateFromCivil(dateRegistered) : null;
          }
          if (incorporationDate !== undefined) {
            updateData.incorporationDate = incorporationDate ? prismaDateFromCivil(incorporationDate) : null;
          }
          if (lastActualAgmDate !== undefined) {
            updateData.lastActualAgmDate = lastActualAgmDate ? prismaDateFromCivil(lastActualAgmDate) : null;
          }
          if (lastUnanimousAnnualMemberResolutionDate !== undefined) {
            updateData.lastUnanimousAnnualMemberResolutionDate = lastUnanimousAnnualMemberResolutionDate
              ? prismaDateFromCivil(lastUnanimousAnnualMemberResolutionDate)
              : null;
          }

          if (legalForm !== undefined) {
            if (legalForm !== null && confirmLegalForm !== true) {
              throw new AppError(
                400,
                'LEGAL_FORM_CONFIRMATION_REQUIRED',
                'Confirm that the legal form was checked before saving it.',
              );
            }
            updateData.legalForm = legalForm;
            updateData.legalFormConfirmedAt = legalForm === null
              ? null
              : current.legalForm === legalForm && current.legalFormConfirmedAt
                ? current.legalFormConfirmedAt
                : new Date();
          } else if (confirmLegalForm !== undefined) {
            if (confirmLegalForm && !current.legalForm) {
              throw new AppError(400, 'LEGAL_FORM_REQUIRED', 'Choose a legal form before confirming it.');
            }
            updateData.legalFormConfirmedAt = confirmLegalForm ? new Date() : null;
          }

          if (croAnnualReturnDate !== undefined) {
            if (croAnnualReturnDate !== null && confirmCroAnnualReturnDate !== true) {
              throw new AppError(
                400,
                'CRO_ARD_CONFIRMATION_REQUIRED',
                'Confirm that the annual return date was checked in CORE before saving it.',
              );
            }
            updateData.croAnnualReturnDate = croAnnualReturnDate
              ? prismaDateFromCivil(croAnnualReturnDate)
              : null;
            updateData.croAnnualReturnDateConfirmedAt = croAnnualReturnDate === null
              ? null
              : current.croAnnualReturnDate?.toISOString().slice(0, 10) === croAnnualReturnDate &&
                  current.croAnnualReturnDateConfirmedAt
                ? current.croAnnualReturnDateConfirmedAt
                : new Date();
          } else if (confirmCroAnnualReturnDate !== undefined) {
            if (confirmCroAnnualReturnDate && !current.croAnnualReturnDate) {
              throw new AppError(400, 'CRO_ARD_REQUIRED', 'Enter the annual return date from CORE before confirming it.');
            }
            updateData.croAnnualReturnDateConfirmedAt = confirmCroAnnualReturnDate ? new Date() : null;
          }

          if (conditionalObligationProfile !== undefined) {
            updateData.conditionalObligationProfile =
              conditionalObligationProfile === null
                ? Prisma.JsonNull
                : { ...conditionalObligationProfile } satisfies Prisma.InputJsonObject;
          }

          const updated = await tx.organisation.update({
            where: { id: organisationId },
            data: updateData,
            select: publicOrganisationSelect,
          });

          if (shouldRegenerateDeadlines) {
            await new DeadlineService(tx).reconcileGeneratedDeadlines(organisationId);
          }

          return updated;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        return publicOrganisation(org);
      } catch (error) {
        if (isRetryableTransactionConflict(error)) {
          if (attempt < 3) continue;
          throw new AppError(
            409,
            'ORGANISATION_UPDATE_CONFLICT',
            'The organisation profile changed concurrently. Try again.',
          );
        }
        throw error;
      }
    }

    throw new AppError(409, 'ORGANISATION_UPDATE_CONFLICT', 'The organisation profile could not be updated. Try again.');
  }
}
