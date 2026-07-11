import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { TeamService } from '../../services/team.service.js';
import { TeamLifecycleService } from '../../services/team-lifecycle.service.js';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { clearAuthCookies, setAuthCookies } from '../../utils/auth-cookies.js';
import {
  acceptTeamInviteSchema,
  inviteTeamMemberSchema,
  updateTeamMemberRoleSchema,
  teamMemberLifecycleActionSchema,
  transferTeamOwnershipSchema,
  revokeTeamSessionSchema,
  revokeTeamInviteSchema,
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
  const lifecycleService = new TeamLifecycleService(app.prisma);

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

    authedApp.get('/', async (request, reply) => {
      try {
        return await service.list(request.user.organisationId, request.user.userId);
      } catch (err) {
        handleError(reply, err);
      }
    });

    authedApp.post('/invites', { preHandler: [subscriptionGuard] }, async (request, reply) => {
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
        const body = revokeTeamInviteSchema.parse(request.body);
        return await service.revoke(
          request.user.organisationId,
          id,
          request.user.userId,
          request.user.role,
          body.reason,
          request.id,
        );
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    });

    authedApp.patch('/members/:id/role', async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = updateTeamMemberRoleSchema.parse(request.body);
        return await lifecycleService.changeMemberRole({
          organisationId: request.user.organisationId,
          actorId: request.user.userId,
          targetUserId: id,
          role: body.role,
          expectedMembershipVersion: body.expectedMembershipVersion,
          reason: body.reason,
          requestId: request.id,
        });
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    });

    authedApp.post('/members/:id/suspend', async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = teamMemberLifecycleActionSchema.parse(request.body);
        return await lifecycleService.suspendMember({
          organisationId: request.user.organisationId,
          actorId: request.user.userId,
          targetUserId: id,
          expectedMembershipVersion: body.expectedMembershipVersion,
          reason: body.reason,
          requestId: request.id,
        });
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    });

    authedApp.post('/members/:id/reactivate', async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = teamMemberLifecycleActionSchema.parse(request.body);
        return await lifecycleService.reactivateMember({
          organisationId: request.user.organisationId,
          actorId: request.user.userId,
          targetUserId: id,
          expectedMembershipVersion: body.expectedMembershipVersion,
          reason: body.reason,
          requestId: request.id,
        });
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    });

    authedApp.post('/members/:id/remove', async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = teamMemberLifecycleActionSchema.parse(request.body);
        return await lifecycleService.removeMember({
          organisationId: request.user.organisationId,
          actorId: request.user.userId,
          targetUserId: id,
          expectedMembershipVersion: body.expectedMembershipVersion,
          reason: body.reason,
          requestId: request.id,
        });
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    });

    authedApp.post('/ownership/transfer', async (request, reply) => {
      try {
        const body = transferTeamOwnershipSchema.parse(request.body);
        const result = await lifecycleService.transferOwnership({
          organisationId: request.user.organisationId,
          actorId: request.user.userId,
          targetMemberId: body.targetMemberId,
          expectedCurrentOwnerVersion: body.expectedCurrentOwnerVersion,
          expectedTargetVersion: body.expectedTargetVersion,
          reason: body.reason,
          requestId: request.id,
        });
        clearAuthCookies(reply);
        return result;
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    });

    authedApp.get('/members/:id/sessions', async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        return await lifecycleService.listSessions({
          organisationId: request.user.organisationId,
          actorId: request.user.userId,
          targetUserId: id,
          currentSessionId: request.user.sessionId,
        });
      } catch (err) {
        handleError(reply, err);
      }
    });

    authedApp.post('/members/:id/sessions/:familyId/revoke', async (request, reply) => {
      try {
        const { id, familyId } = request.params as { id: string; familyId: string };
        const body = revokeTeamSessionSchema.parse(request.body);
        const result = await lifecycleService.revokeSessionFamily({
          organisationId: request.user.organisationId,
          actorId: request.user.userId,
          targetUserId: id,
          familyId,
          expectedMembershipVersion: body.expectedMembershipVersion,
          reason: body.reason,
          requestId: request.id,
          currentSessionId: request.user.sessionId,
        });
        if (result.revokedCurrentSession) clearAuthCookies(reply);
        return result;
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    });

    authedApp.post('/members/:id/sessions/revoke-all', async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = revokeTeamSessionSchema.parse(request.body);
        const result = await lifecycleService.revokeAllSessions({
          organisationId: request.user.organisationId,
          actorId: request.user.userId,
          targetUserId: id,
          expectedMembershipVersion: body.expectedMembershipVersion,
          reason: body.reason,
          requestId: request.id,
        });
        if (id === request.user.userId) clearAuthCookies(reply);
        return result;
      } catch (err) {
        if (err instanceof ZodError) {
          reply.status(400).send(formatZodError(err));
          return;
        }
        handleError(reply, err);
      }
    });

    authedApp.get('/security-audit', async (request, reply) => {
      try {
        return await lifecycleService.listSecurityAudit(
          request.user.organisationId,
          request.user.userId,
        );
      } catch (err) {
        handleError(reply, err);
      }
    });
  });
}
