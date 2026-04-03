import type { FastifyInstance } from 'fastify';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { ComplianceService } from '../../services/compliance.service.js';
import { ActivityService } from '../../services/activity.service.js';
import { handleError } from '../../utils/errors.js';
import { sendSuccess } from '../../utils/response.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);

  // GET / — combined dashboard data
  app.get('/', async (request, reply) => {
    try {
      const { organisationId } = request.user;
      const currentYear = new Date().getFullYear();

      const complianceService = new ComplianceService(app.prisma);
      const activityService = new ActivityService(app.prisma);

      const now = new Date();
      const eightYearsAgo = new Date(now);
      eightYearsAgo.setFullYear(eightYearsAgo.getFullYear() - 8);
      const nineYearsAgo = new Date(now);
      nineYearsAgo.setFullYear(nineYearsAgo.getFullYear() - 9);

      const [compliance, upcomingDeadlines, boardMembers, recentActivity] = await Promise.all([
        complianceService.getSummary(organisationId, currentYear),

        app.prisma.deadline.findMany({
          where: {
            organisationId,
            isComplete: false,
            dueDate: { gte: now },
          },
          orderBy: { dueDate: 'asc' },
          take: 5,
        }),

        app.prisma.boardMember.findMany({
          where: { organisationId },
        }),

        activityService.getRecentActivity(organisationId, 10),
      ]);

      // Build board alerts
      const boardAlerts = boardMembers.flatMap((member) => {
        const alerts: Array<{
          memberId: string;
          memberName: string;
          alertType: 'conduct_unsigned' | 'induction_pending' | 'term_expiring';
        }> = [];

        if (!member.conductSigned) {
          alerts.push({
            memberId: member.id,
            memberName: member.name,
            alertType: 'conduct_unsigned',
          });
        }

        if (!member.inductionCompleted && member.isActive) {
          alerts.push({
            memberId: member.id,
            memberName: member.name,
            alertType: 'induction_pending',
          });
        }

        // Term expiring: appointed 8+ years ago (within 1 year of 9-year limit)
        if (member.appointedDate >= nineYearsAgo && member.appointedDate <= eightYearsAgo) {
          alerts.push({
            memberId: member.id,
            memberName: member.name,
            alertType: 'term_expiring',
          });
        }

        return alerts;
      });

      return sendSuccess(reply, {
        compliance,
        upcomingDeadlines,
        boardAlerts,
        recentActivity,
      });
    } catch (err) {
      handleError(reply, err);
    }
  });
}
