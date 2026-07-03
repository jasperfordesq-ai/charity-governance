import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { TeamService } from '../../services/team.service.js';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { setAuthCookies } from '../../utils/auth-cookies.js';
import {
  acceptTeamInviteSchema,
  inviteTeamMemberSchema,
  updateTeamMemberRoleSchema,
} from '@charitypilot/shared';
import { handleError } from '../../utils/errors.js';
import { publicUser } from '../../utils/public-dtos.js';
import { bodyIdentifierRateLimit } from '../../utils/identifier-rate-limit.js';

function formatZodError(error: ZodError) {
  return {
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    details: error.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    })),
  };
}

export async function teamRoutes(app: FastifyInstance) {
  const service = new TeamService(app.prisma);

  app.post(
    '/accept-invite',
    { config: { rateLimit: bodyIdentifierRateLimit(['token']) } },
    async (request, reply) => {
      try {
        const body = acceptTeamInviteSchema.parse(request.body);
        const result = await service.acceptInvite(body);

        setAuthCookies(reply, result);
        reply.status(201).send({
          user: publicUser(result.user),
        });
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    },
  );

  app.register(async (authedApp: FastifyInstance) => {
    authedApp.addHook('onRequest', authGuard);
    authedApp.addHook('onRequest', subscriptionGuard);

    authedApp.get('/', async (request, reply) => {
      try {
        return await service.list(request.user.organisationId);
      } catch (err) {
        handleError(reply, err);
      }
    });

    authedApp.post('/invites', async (request, reply) => {
      try {
        const body = inviteTeamMemberSchema.parse(request.body);
        const invite = await service.invite(
          request.user.organisationId,
          request.user.userId,
          request.user.role,
          body,
        );
        reply.status(202).send(invite);
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    });

    authedApp.delete('/invites/:id', async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        return await service.revoke(request.user.organisationId, id, request.user.role);
      } catch (err) {
        handleError(reply, err);
      }
    });

    authedApp.patch('/members/:id/role', async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = updateTeamMemberRoleSchema.parse(request.body);
        return await service.updateMemberRole(
          request.user.organisationId,
          request.user.userId,
          request.user.role,
          id,
          body.role,
        );
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    });
  });
}
