import type { Organisation, UserRole } from '@prisma/client';

export type PublicOrganisation = Pick<
  Organisation,
  | 'id'
  | 'name'
  | 'rcnNumber'
  | 'croNumber'
  | 'legalForm'
  | 'complexity'
  | 'charitablePurpose'
  | 'financialYearEnd'
  | 'registeredAddress'
  | 'contactEmail'
  | 'contactPhone'
  | 'website'
  | 'dateRegistered'
  | 'lastAgmDate'
>;

export const publicOrganisationSelect = {
  id: true,
  name: true,
  rcnNumber: true,
  croNumber: true,
  legalForm: true,
  complexity: true,
  charitablePurpose: true,
  financialYearEnd: true,
  registeredAddress: true,
  contactEmail: true,
  contactPhone: true,
  website: true,
  dateRegistered: true,
  lastAgmDate: true,
} satisfies Record<keyof PublicOrganisation, true>;

export type PublicUserSource = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  emailVerified: boolean;
  organisationId: string;
  organisation: PublicOrganisation;
};

export function publicOrganisation(organisation: PublicOrganisation): PublicOrganisation {
  return {
    id: organisation.id,
    name: organisation.name,
    rcnNumber: organisation.rcnNumber,
    croNumber: organisation.croNumber,
    legalForm: organisation.legalForm,
    complexity: organisation.complexity,
    charitablePurpose: organisation.charitablePurpose,
    financialYearEnd: organisation.financialYearEnd,
    registeredAddress: organisation.registeredAddress,
    contactEmail: organisation.contactEmail,
    contactPhone: organisation.contactPhone,
    website: organisation.website,
    dateRegistered: organisation.dateRegistered,
    lastAgmDate: organisation.lastAgmDate,
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
