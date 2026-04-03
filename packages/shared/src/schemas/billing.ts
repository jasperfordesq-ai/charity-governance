import { z } from 'zod';

const planValues = ['ESSENTIALS', 'COMPLETE'] as const;
const intervalValues = ['monthly', 'yearly'] as const;

export const createCheckoutSchema = z.object({
  plan: z.enum(planValues),
  interval: z.enum(intervalValues),
});
