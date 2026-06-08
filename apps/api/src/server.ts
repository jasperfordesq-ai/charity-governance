import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { prismaPlugin } from './plugins/prisma.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { securityHeadersPlugin } from './plugins/security-headers.js';
import { registerBrowserOriginProtection } from './plugins/browser-origin-protection.js';
import { authRoutes } from './routes/auth/index.js';
import { organisationRoutes } from './routes/organisations/index.js';
import { complianceRoutes } from './routes/compliance/index.js';
import { boardMemberRoutes } from './routes/board-members/index.js';
import { documentRoutes } from './routes/documents/index.js';
import { deadlineRoutes } from './routes/deadlines/index.js';
import { billingRoutes } from './routes/billing/index.js';
import { exportRoutes } from './routes/export/index.js';
import { dashboardRoutes } from './routes/dashboard/index.js';
import { governanceRegisterRoutes } from './routes/governance-registers/index.js';
import { teamRoutes } from './routes/team/index.js';
import { healthRoutes } from './routes/health/index.js';
import { DeadlineRemindersService } from './services/deadline-reminders.service.js';
import { startCronJobs } from './utils/cron.js';
import { validateProductionEnv } from './utils/env.js';
import { parsePort } from './utils/port.js';
import { normaliseOrigin } from './utils/request-origin.js';

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
const defaultFrontendOrigins = ['http://localhost:3003', 'http://localhost:3000'];

const allowedOrigins = new Set(
  (process.env.FRONTEND_URL?.split(',') ?? defaultFrontendOrigins)
    .map((origin) => origin.trim())
    .map(normaliseOrigin)
    .filter(Boolean),
);
const trustedProxyAddresses = (process.env.TRUSTED_PROXY_ADDRESSES ?? '')
  .split(',')
  .map((address) => address.trim())
  .filter(Boolean);

validateProductionEnv();

const app = Fastify({
  logger: envToLogger[environment] ?? true,
  trustProxy: trustedProxyAddresses.length > 0 ? trustedProxyAddresses : false,
});

// ── Plugins ──

await app.register(errorHandlerPlugin);
await app.register(securityHeadersPlugin);
await app.register(cookie);

await registerBrowserOriginProtection(app, allowedOrigins);

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
await app.register(governanceRegisterRoutes, { prefix: '/api/v1/governance-registers' });
await app.register(teamRoutes, { prefix: '/api/v1/team' });
await app.register(healthRoutes, { prefix: '/api/v1/health' });

// ── Health check ──

// ── Start ──

const port = parsePort(process.env.PORT, 3002);
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

let isShuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  app.log.info({ signal }, 'Shutting down CharityPilot API');

  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error(err, 'Graceful shutdown failed');
    process.exit(1);
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
