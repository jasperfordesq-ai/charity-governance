import type { Organisation, UserRole } from '@prisma/client';
import {
  conditionalObligationProfileSchema,
  type ConditionalObligationProfile,
} from '@charitypilot/shared';
import { nullableCivilDateFromPrisma } from './civil-date.js';

export type PublicOrganisationSource = Pick<
  Organisation,
  | 'id'
  | 'name'
  | 'rcnNumber'
  | 'croNumber'
  | 'legalForm'
  | 'legalFormConfirmedAt'
  | 'complexity'
  | 'charitablePurpose'
  | 'financialYearEnd'
  | 'registeredAddress'
  | 'contactEmail'
  | 'contactPhone'
  | 'website'
  | 'dateRegistered'
  | 'incorporationDate'
  | 'croAnnualReturnDate'
  | 'croAnnualReturnDateConfirmedAt'
  | 'lastActualAgmDate'
  | 'lastUnanimousAnnualMemberResolutionDate'
  | 'memberCount'
  | 'updatedAt'
> & {
  conditionalObligationProfile: unknown;
};

export type PublicOrganisation = Omit<
  PublicOrganisationSource,
  | 'financialYearEnd'
  | 'dateRegistered'
  | 'incorporationDate'
  | 'croAnnualReturnDate'
  | 'lastActualAgmDate'
  | 'lastUnanimousAnnualMemberResolutionDate'
  | 'legalFormConfirmedAt'
  | 'croAnnualReturnDateConfirmedAt'
  | 'conditionalObligationProfile'
  | 'updatedAt'
> & {
  financialYearEnd: string | null;
  dateRegistered: string | null;
  incorporationDate: string | null;
  croAnnualReturnDate: string | null;
  lastActualAgmDate: string | null;
  lastUnanimousAnnualMemberResolutionDate: string | null;
  legalFormConfirmedAt: string | null;
  croAnnualReturnDateConfirmedAt: string | null;
  conditionalObligationProfile: ConditionalObligationProfile | null;
  updatedAt: string;
};

export const publicOrganisationSelect = {
  id: true,
  name: true,
  rcnNumber: true,
  croNumber: true,
  legalForm: true,
  legalFormConfirmedAt: true,
  complexity: true,
  charitablePurpose: true,
  financialYearEnd: true,
  registeredAddress: true,
  contactEmail: true,
  contactPhone: true,
  website: true,
  dateRegistered: true,
  incorporationDate: true,
  croAnnualReturnDate: true,
  croAnnualReturnDateConfirmedAt: true,
  lastActualAgmDate: true,
  lastUnanimousAnnualMemberResolutionDate: true,
  memberCount: true,
  conditionalObligationProfile: true,
  updatedAt: true,
} satisfies Record<keyof PublicOrganisationSource, true>;

export type PublicUserSource = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  emailVerified: boolean;
  organisationId: string;
  organisation: PublicOrganisationSource;
};

function publicConditionalObligationProfile(value: unknown): ConditionalObligationProfile | null {
  if (value === null || value === undefined) {
    return null;
  }
  const result = conditionalObligationProfileSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function publicOrganisation(organisation: PublicOrganisationSource): PublicOrganisation {
  return {
    id: organisation.id,
    name: organisation.name,
    rcnNumber: organisation.rcnNumber,
    croNumber: organisation.croNumber,
    legalForm: organisation.legalForm,
    legalFormConfirmedAt: organisation.legalFormConfirmedAt?.toISOString() ?? null,
    complexity: organisation.complexity,
    charitablePurpose: organisation.charitablePurpose,
    financialYearEnd: nullableCivilDateFromPrisma(organisation.financialYearEnd),
    registeredAddress: organisation.registeredAddress,
    contactEmail: organisation.contactEmail,
    contactPhone: organisation.contactPhone,
    website: organisation.website,
    dateRegistered: nullableCivilDateFromPrisma(organisation.dateRegistered),
    incorporationDate: nullableCivilDateFromPrisma(organisation.incorporationDate),
    croAnnualReturnDate: nullableCivilDateFromPrisma(organisation.croAnnualReturnDate),
    croAnnualReturnDateConfirmedAt: organisation.croAnnualReturnDateConfirmedAt?.toISOString() ?? null,
    lastActualAgmDate: nullableCivilDateFromPrisma(organisation.lastActualAgmDate),
    lastUnanimousAnnualMemberResolutionDate: nullableCivilDateFromPrisma(
      organisation.lastUnanimousAnnualMemberResolutionDate,
    ),
    memberCount: organisation.memberCount,
    conditionalObligationProfile: publicConditionalObligationProfile(organisation.conditionalObligationProfile),
    updatedAt: organisation.updatedAt.toISOString(),
  };
}

export function publicUser(user: PublicUserSource) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    emailVerified: user.emailVerified,
    organisationId: user.organisationId,
    organisation: publicOrganisation(user.organisation),
  };
}
