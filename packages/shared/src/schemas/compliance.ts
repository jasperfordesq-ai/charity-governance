import { z } from 'zod';

const complianceStatusValues = [
  'COMPLIANT',
  'WORKING_TOWARDS',
  'NOT_STARTED',
  'NOT_APPLICABLE',
  'EXPLAIN',
] as const;

export const upsertComplianceRecordSchema = z.object({
  reportingYear: z.number().int().min(2018).max(2100),
  status: z.enum(complianceStatusValues).optional(),
  actionTaken: z.string().max(5000).nullable().optional(),
  evidence: z.string().max(5000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  explanationIfNA: z.string().max(5000).nullable().optional(),
});

export const complianceQuerySchema = z.object({
  year: z.coerce.number().int().min(2018).max(2100),
});
