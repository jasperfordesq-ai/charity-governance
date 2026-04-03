import type { FastifyInstance } from 'fastify';
import { OrganisationService } from '../../services/organisation.service.js';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { updateOrganisationSchema, type UpdateOrganisationRequest } from '@charitypilot/shared';
import { handleError } from '../../utils/errors.js';
import { sendSuccess } from '../../utils/response.js';
import { ZodError } from 'zod';

export async function organisationRoutes(app: FastifyInstance) {
  const service = new OrganisationService(app.prisma);

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);

  app.get('/', async (request, reply) => {
    try {
      const org = await service.getOrganisation(request.user.organisationId);
      return sendSuccess(reply, org);
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.patch('/', async (request, reply) => {
    try {
      const data = updateOrganisationSchema.parse(request.body) as UpdateOrganisationRequest;
      const org = await service.updateOrganisation(request.user.organisationId, data);
      return sendSuccess(reply, org);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });
}
