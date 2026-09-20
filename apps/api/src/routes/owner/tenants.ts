import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { handleError } from '../../utils/errors.js';
import { requirePlatformOperator } from '../../middleware/owner-auth.js';
import { requireOperatorSessionLevel } from '../../middleware/owner-session-level.js';
import { requireOperatorActionApproval } from '../../middleware/owner-action-approval.js';
import { listTenants, getTenant, transitionTenantLifecycle } from '../../services/owner-tenants.service.js';
import { provisionTenant } from '../../services/owner-provisioning.service.js';
import {
  getTenantConfiguration,
  updateTenantConfiguration,
  listTenantAdministrativeEvents,
} from '../../services/owner-tenant-configuration.service.js';

/**
 * What a platform operator may change about a charity they do not belong to.
 *
 * Every field is optional and absent means "leave it alone", so a request that
 * only wants to change the plan cannot accidentally reset the storage provider
 * to whatever the form happened to render. `documentStorageProvider` is
 * nullable on purpose: null is a meaningful value meaning "follow the
 * deployment default", and is not the same as omitting it.
 */
const configurationSchema = z.object({
  documentStorageProvider: z.string().trim().min(1).max(64).nullable().optional(),
  documentStorageAlphaOptIn: z.boolean().optional(),
  plan: z.enum(['ESSENTIALS', 'COMPLETE']).optional(),
  reason: z.string().trim().min(1).max(500),
});

const listQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function ownerTenantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requirePlatformOperator);

  // The two questions a write has to answer, asked in order.
  //
  // The level says this session was ever connected with the authority to do
  // this. The approval says a person agreed to this particular action, just
  // now. A console session satisfies the second trivially — the approval guard
  // returns immediately for anything that is not a connector — so these change
  // nothing for the browser.
  //
  // Every operator write is approved, not only the destructive ones. A charity
  // connector's mistake is contained to one charity, whose own people see it in
  // their activity record; an operator's reaches across tenants.
  const write = { preHandler: [requireOperatorSessionLevel('WRITE'), requireOperatorActionApproval()] };
  // Closing a charity ends its access to the product. It asks for the level
  // that has to be chosen deliberately at connect.
  const destructive = { preHandler: [requireOperatorSessionLevel('ADMIN'), requireOperatorActionApproval()] };

  app.get('/tenants', async (request, reply) => {
    try {
      return reply.send(await listTenants(app.prisma, listQuerySchema.parse(request.query ?? {})));
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
      }
      return handleError(reply, err);
    }
  });

  app.get('/tenants/:id/history', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
      return reply.send({ events: await listTenantAdministrativeEvents(app.prisma, id) });
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
      }
      return handleError(reply, err);
    }
  });

  app.get('/tenants/:id/configuration', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
      return reply.send({ configuration: await getTenantConfiguration(app.prisma, id) });
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
      }
      return handleError(reply, err);
    }
  });

  app.patch('/tenants/:id/configuration', write, async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
      const { reason, ...change } = configurationSchema.parse(request.body ?? {});

      return reply.send({
        configuration: await updateTenantConfiguration(app.prisma, {
          tenantId: id,
          change,
          reason,
          operator: { id: request.operator.id, email: request.operator.email },
        }),
      });
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
      }
      return handleError(reply, err);
    }
  });

  app.get('/tenants/:id', async (request, reply) => {
    try {
      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
      return reply.send({ tenant: await getTenant(app.prisma, id) });
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
      }
      return handleError(reply, err);
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

  app.post('/tenants/:id/lifecycle', destructive, async (request, reply) => {
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
      return reply.send({ tenant });
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
      }
      return handleError(reply, err);
    }
  });

  const provisionBodySchema = z
    .object({
      organisationName: z.string().trim().min(1).max(200),
      ownerName: z.string().trim().min(1).max(200),
      ownerEmail: z.string().email().max(254),
      plan: z.enum(['ESSENTIALS', 'COMPLETE']),
      billing: z.enum(['trial', 'comped']).default('trial'),
      trialDays: z.number().int().min(1).max(365).optional(),
    })
    .superRefine((body, ctx) => {
      if (body.billing === 'trial' && body.trialDays === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['trialDays'], message: 'trialDays is required for trial billing' });
      }
      if (body.billing === 'comped' && body.trialDays !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['trialDays'], message: 'trialDays is not allowed for comped billing' });
      }
    });

  app.post('/tenants', write, async (request, reply) => {
    try {
      const body = provisionBodySchema.parse(request.body);
      const result = await provisionTenant(app.prisma, body);
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR' });
      }
      return handleError(reply, err);
    }
  });
}
