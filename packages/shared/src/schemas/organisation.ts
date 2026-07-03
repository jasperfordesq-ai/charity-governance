import { z } from 'zod';
import { dateInputSchema } from './date.js';

const legalFormValues = ['CLG', 'TRUST', 'UNINCORPORATED_ASSOCIATION', 'OTHER'] as const;
const complexityValues = ['SIMPLE', 'COMPLEX'] as const;
const charitablePurposeValues = ['POVERTY_RELIEF', 'EDUCATION', 'RELIGION', 'COMMUNITY_BENEFIT'] as const;

export const updateOrganisationSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  rcnNumber: z.string().max(20).nullable().optional(),
  croNumber: z.string().max(20).nullable().optional(),
  legalForm: z.enum(legalFormValues).optional(),
  complexity: z.enum(complexityValues).optional(),
  charitablePurpose: z.array(z.enum(charitablePurposeValues)).optional(),
  financialYearEnd: dateInputSchema.nullable().optional(),
  registeredAddress: z.string().max(500).nullable().optional(),
  contactEmail: z.string().email().nullable().optional(),
  contactPhone: z.string().max(30).nullable().optional(),
  website: z.string().url().nullable().optional(),
  dateRegistered: dateInputSchema.nullable().optional(),
  lastAgmDate: dateInputSchema.nullable().optional(),
});
