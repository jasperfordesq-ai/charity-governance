import { z } from "zod";
import { civilDateSchema } from "./date.js";

const legalFormValues = [
  "CLG",
  "TRUST",
  "UNINCORPORATED_ASSOCIATION",
  "OTHER",
] as const;
const complexityValues = ["SIMPLE", "COMPLEX"] as const;
const charitablePurposeValues = [
  "POVERTY_RELIEF",
  "EDUCATION",
  "RELIGION",
  "COMMUNITY_BENEFIT",
] as const;

// Prisma `Int` maps to PostgreSQL INTEGER, whose signed upper bound is
// 2,147,483,647. Keep the public contract inside the storage boundary so an
// otherwise valid request can never fail as an internal database error.
export const MAX_ORGANISATION_MEMBER_COUNT = 2_147_483_647;

const legalCalendarDateSchema = civilDateSchema.refine(
  (value) => value <= "9997-12-31",
  "Date exceeds the supported legal calendar range",
);

export const conditionalObligationProfileSchema = z
  .object({
    hasPaidStaff: z.boolean(),
    hasVolunteers: z.boolean(),
    raisesFundsFromPublic: z.boolean(),
    worksWithChildrenOrVulnerableAdults: z.boolean(),
    processesPersonalData: z.boolean(),
    operatesPremisesOrEvents: z.boolean(),
    isPublicSectorBody: z.boolean(),
    usesDataProcessors: z.boolean(),
  })
  .strict();

export const updateOrganisationSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  name: z.string().min(1).max(300).optional(),
  rcnNumber: z.string().max(20).nullable().optional(),
  croNumber: z.string().max(20).nullable().optional(),
  legalForm: z.enum(legalFormValues).nullable().optional(),
  confirmLegalForm: z.boolean().optional(),
  complexity: z.enum(complexityValues).optional(),
  charitablePurpose: z.array(z.enum(charitablePurposeValues)).optional(),
  financialYearEnd: legalCalendarDateSchema.nullable().optional(),
  registeredAddress: z.string().max(500).nullable().optional(),
  contactEmail: z.string().email().nullable().optional(),
  contactPhone: z.string().max(30).nullable().optional(),
  website: z.string().url().nullable().optional(),
  dateRegistered: legalCalendarDateSchema.nullable().optional(),
  incorporationDate: legalCalendarDateSchema.nullable().optional(),
  croAnnualReturnDate: legalCalendarDateSchema.nullable().optional(),
  confirmCroAnnualReturnDate: z.boolean().optional(),
  lastActualAgmDate: legalCalendarDateSchema.nullable().optional(),
  lastUnanimousAnnualMemberResolutionDate: legalCalendarDateSchema
    .nullable()
    .optional(),
  memberCount: z
    .number()
    .int()
    .min(1)
    .max(MAX_ORGANISATION_MEMBER_COUNT)
    .nullable()
    .optional(),
  conditionalObligationProfile: conditionalObligationProfileSchema
    .nullable()
    .optional(),
}).superRefine((data, context) => {
  if (data.confirmLegalForm === true && data.legalForm === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["confirmLegalForm"],
      message: "A legal form is required before it can be confirmed",
    });
  }
  if (
    data.confirmCroAnnualReturnDate === true &&
    data.croAnnualReturnDate === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["confirmCroAnnualReturnDate"],
      message: "A CRO Annual Return Date is required before it can be confirmed",
    });
  }
  if (data.incorporationDate) {
    for (const [field, value, label] of [
      ["lastActualAgmDate", data.lastActualAgmDate, "Last actual AGM date"],
      [
        "lastUnanimousAnnualMemberResolutionDate",
        data.lastUnanimousAnnualMemberResolutionDate,
        "Written-resolution date",
      ],
      ["croAnnualReturnDate", data.croAnnualReturnDate, "CRO Annual Return Date"],
    ] as const) {
      if (value && value < data.incorporationDate) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${label} cannot be before the incorporation date`,
        });
      }
    }
  }
});
