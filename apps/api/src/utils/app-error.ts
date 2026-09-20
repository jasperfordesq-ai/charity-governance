/**
 * AppError lives apart from the reply helpers in ./errors.ts, which import
 * fastify, the logger and the alert webhook.
 *
 * The class itself needs none of that — it is an Error with a status code and
 * a machine-readable code — but anything importing it from ./errors.ts drags
 * the whole framework in behind it. That matters for the modules the E2E
 * harness shares (see scripts/check-e2e-api-imports.mjs): they are type-checked
 * with only the harness's own dependencies installed, so a stray fastify import
 * breaks a build a long way from here.
 *
 * ./errors.ts re-exports this, so every existing import and `instanceof AppError`
 * keeps working — there is still exactly one class.
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
