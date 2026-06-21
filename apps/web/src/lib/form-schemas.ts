// Client-side form validation sourced from the SAME @charitypilot/shared Zod schemas the
// API validates with. Importing the shared schemas here (rather than re-implementing
// rules inline) makes client/server drift impossible: if the server tightens a rule, the
// client tightens with it. The forms gate their submit with firstSchemaError(...) so a
// guaranteed-400 payload (e.g. a long-but-weak password) is caught inline instead of
// being sent and bounced.
import {
  loginSchema,
  registerSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  acceptTeamInviteSchema,
} from '@charitypilot/shared';

export { loginSchema, registerSchema, forgotPasswordSchema, resetPasswordSchema, acceptTeamInviteSchema };

type SafeParser = {
  safeParse: (data: unknown) => { success: boolean; error?: { issues: { message: string }[] } };
};

/** The first human-readable validation message for `data` against `schema`, or null if valid. */
export function firstSchemaError(schema: SafeParser, data: unknown): string | null {
  const result = schema.safeParse(data);
  if (result.success) return null;
  return result.error?.issues?.[0]?.message ?? 'Please check the form and try again.';
}

/** The shared password rule (from registerSchema) for inline per-field validation. */
export function passwordIssue(password: string): string | null {
  return firstSchemaError(registerSchema.shape.password as unknown as SafeParser, password);
}
