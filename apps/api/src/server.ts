import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
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
import { governanceRegisterRoutes } from './routes/governance-registers/index.js';
import { teamRoutes } from './routes/team/index.js';
import { DeadlineRemindersService } from './services/deadline-reminders.service.js';
import { BillingService } from './services/billing.service.js';
import { EmailService } from './services/email.service.js';
import { StorageService } from './services/storage.service.js';
import { startCronJobs } from './utils/cron.js';
import { validateProductionEnv } from './utils/env.js';
import { parsePort } from './utils/port.js';

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
const isProduction = environment === 'production';
const defaultFrontendOrigins = ['http://localhost:3003', 'http://localhost:3000'];
const allowedOrigins = new Set(
  (process.env.FRONTEND_URL?.split(',') ?? defaultFrontendOrigins)
    .map((origin) => origin.trim())
    .filter(Boolean),
);

validateProductionEnv();

const app = Fastify({
  logger: envToLogger[environment] ?? true,
});

// ── Plugins ──

await app.register(errorHandlerPlugin);

app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (isProduction) {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return payload;
});

app.addHook('preHandler', async (request, reply) => {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    return;
  }

  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    return reply.status(403).send({
      error: 'Invalid request origin',
      code: 'INVALID_ORIGIN',
    });
  }
});

await app.register(cors, {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin not allowed by CORS'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

await app.register(cookie);

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

// ── Health check ──

app.get('/api/v1/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/api/v1/health/readiness', async (request, reply) => {
  const billing = new BillingService(app.prisma);
  const email = new EmailService();
  const storage = new StorageService();

  let database = false;
  try {
    await app.prisma.$queryRaw`SELECT 1`;
    database = true;
  } catch (err) {
    request.log.error(err, 'Readiness database check failed');
  }

  const checks = {
    database,
    billingConfigured: billing.isConfigured(),
    emailConfigured: email.isConfigured(),
    storageConfigured: storage.isConfigured(),
    storageBucketReachable: await storage.verifyBucket(),
  };

  const ready =
    database &&
    checks.billingConfigured &&
    checks.emailConfigured &&
    checks.storageConfigured &&
    checks.storageBucketReachable;
  reply.status(ready ? 200 : 503).send({
    status: ready ? 'ready' : 'not_ready',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// ── Start ──

const port = parsePort(process.env.PORT, isProduction ? 3002 : 3001);
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
