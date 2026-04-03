import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { prismaPlugin } from './plugins/prisma.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { authRoutes } from './routes/auth/index.js';
import { organisationRoutes } from './routes/organisations/index.js';
import { complianceRoutes } from './routes/compliance/index.js';
import { boardMemberRoutes } from './routes/board-members/index.js';
import { documentRoutes } from './routes/documents/index.js';
import { deadlineRoutes } from './routes/deadlines/index.js';
import { billingRoutes } from './routes/billing/index.js';
import { exportRoutes } from './routes/export/index.js';
import { dashboardRoutes } from './routes/dashboard/index.js';
import { DeadlineRemindersService } from './services/deadline-reminders.service.js';
import { startCronJobs } from './utils/cron.js';

const envToLogger: Record<string, unknown> = {
  development: {
    transport: {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
    },
  },
  production: true,
  test: false,
};

const environment = process.env.NODE_ENV ?? 'development';

const app = Fastify({
  logger: envToLogger[environment] ?? true,
});

// ── Plugins ──

await app.register(errorHandlerPlugin);

await app.register(cors, {
  origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  credentials: true,
});

await app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

await app.register(multipart, {
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
});

await app.register(prismaPlugin);

// ── Routes ──

await app.register(authRoutes, { prefix: '/api/v1/auth' });
await app.register(organisationRoutes, { prefix: '/api/v1/organisation' });
await app.register(complianceRoutes, { prefix: '/api/v1/compliance' });
await app.register(boardMemberRoutes, { prefix: '/api/v1/board-members' });
await app.register(documentRoutes, { prefix: '/api/v1/documents' });
await app.register(deadlineRoutes, { prefix: '/api/v1/deadlines' });
await app.register(billingRoutes, { prefix: '/api/v1/billing' });
await app.register(exportRoutes, { prefix: '/api/v1/export' });
await app.register(dashboardRoutes, { prefix: '/api/v1/dashboard' });

// ── Health check ──

app.get('/api/v1/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Start ──

const port = parseInt(process.env.PORT ?? '3001', 10);
const host = process.env.HOST ?? '0.0.0.0';

try {
  await app.listen({ port, host });
  app.log.info(`CharityPilot API running on http://${host}:${port}`);

  // ── Cron jobs ──
  const deadlineRemindersService = new DeadlineRemindersService(app.prisma);
  startCronJobs(deadlineRemindersService);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
