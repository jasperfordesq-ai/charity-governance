import { z } from "zod";
import { CONDITIONAL_OBLIGATION_REVIEW_RULES } from "../constants/irish-compliance-matrix.js";
import type { ConditionalObligationProfile } from "../types/api.js";
import { civilDateSchema } from "./date.js";

const profileRuleKeys = new Set<keyof ConditionalObligationProfile>(
  CONDITIONAL_OBLIGATION_REVIEW_RULES.map((rule) => rule.profileKey),
);

export const deadlineProfileRuleKeySchema = z
  .string()
  .refine(
    (value): value is keyof ConditionalObligationProfile =>
      profileRuleKeys.has(value as keyof ConditionalObligationProfile),
    "Profile rule key must identify a supported conditional-obligation review rule",
  );

export const createDeadlineSchema = z.object({
  title: z.string().min(1, "Title is required").max(300),
  description: z.string().max(1000).optional(),
  dueDate: civilDateSchema,
  reminderDays: z.array(z.number().int().min(1).max(365)).optional(),
  profileRuleKey: deadlineProfileRuleKeySchema.optional(),
});

export const updateDeadlineSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(1000).nullable().optional(),
  dueDate: civilDateSchema.optional(),
  isComplete: z.boolean().optional(),
  reminderDays: z.array(z.number().int().min(1).max(365)).optional(),
});

export const deleteDeadlineSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});
