import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { handleError } from '../../utils/errors.js';
import { requirePlatformOperator } from '../../middleware/owner-auth.js';
import { listTenants, getTenant, transitionTenantLifecycle } from '../../services/owner-tenants.service.js';

const listQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function ownerTenantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requirePlatformOperator);

  app.get('/tenants', async (request, reply) => {
    try {
      reply.send(await listTenants(app.prisma, listQuerySchema.parse(request.query ?? {})));
    } catch (err) {
      if (err instanceof ZodError) {
        reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
        return;
      }
      handleError(reply, err);
    }
  });

  app.get('/tenants/:id', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
      reply.send({ tenant: await getTenant(app.prisma, id) });
    } catch (err) {
      if (err instanceof ZodError) {
        reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
        return;
      }
      handleError(reply, err);
    }
  });

  const lifecycleBodySchema = z.object({
    action: z.enum(['SUSPEND', 'REACTIVATE', 'CLOSE']),
    // Deliberately NOT .trim()'d here: a whitespace-only reason must still
    // reach transitionTenantLifecycle so its own trim-and-reject guard is the
    // one that produces REASON_REQUIRED, rather than Zod's min(1) rejecting
    // it first as a generic VALIDATION_ERROR.
    reason: z.string().min(1).max(1000),
    expectedLifecycleVersion: z.number().int().min(1),
  });

  app.post('/tenants/:id/lifecycle', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
      const body = lifecycleBodySchema.parse(request.body);
      const tenant = await transitionTenantLifecycle(app.prisma, {
        tenantId: id,
        action: body.action,
        reason: body.reason,
        expectedLifecycleVersion: body.expectedLifecycleVersion,
        operator: request.operator,
      });
      reply.send({ tenant });
    } catch (err) {
      if (err instanceof ZodError) {
        reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
        return;
      }
      handleError(reply, err);
    }
  });
}
