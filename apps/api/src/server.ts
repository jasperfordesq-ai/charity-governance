import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { prismaPlugin } from './plugins/prisma.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { securityHeadersPlugin } from './plugins/security-headers.js';
import { registerBrowserOriginProtection } from './plugins/browser-origin-protection.js';
import { clientActivityLogPlugin } from './plugins/client-activity-log.js';
import { connectorWriteBudgetPlugin } from './plugins/connector-write-budget.js';
import { authRoutes } from './routes/auth/index.js';
import { connectorAuthRoutes } from './routes/auth/connector.js';
import { organisationRoutes } from './routes/organisations/index.js';
import { complianceRoutes } from './routes/compliance/index.js';
import { boardMemberRoutes } from './routes/board-members/index.js';
import { documentRoutes, DOCUMENT_UPLOAD_MULTIPART_LIMITS } from './routes/documents/index.js';
import { deadlineRoutes } from './routes/deadlines/index.js';
import { billingRoutes } from './routes/billing/index.js';
import { exportRoutes } from './routes/export/index.js';
import { dashboardRoutes } from './routes/dashboard/index.js';
import { governanceRegisterRoutes } from './routes/governance-registers/index.js';
import { governingActRoutes } from './routes/governing-acts/index.js';
import { memberRoutes } from './routes/members/index.js';
import { teamRoutes } from './routes/team/index.js';
import { healthRoutes } from './routes/health/index.js';
import { integrationRoutes, INTEGRATION_ROUTES_PREFIX } from './routes/integrations/index.js';
import { ownerRoutes } from './routes/owner/index.js';
import { assertOwnerJwtSecretConfigured } from './utils/owner-jwt.js';
import { isMultiTenant } from './utils/deployment-profile.js';
import { DeadlineRemindersService } from './services/deadline-reminders.service.js';
import { AuthEmailDeliveryService } from './services/auth-email-delivery.service.js';
import { bindAuthRecoveryControlForRuntime } from './services/auth-recovery-control.js';
import { startCronJobs, startLocalAuthDeliveryCron } from './utils/cron.js';
import { validateRuntimeEnv } from './utils/personal-server-env.js';
import { apiLoggerOptionsForEnvironment } from './utils/logger.js';
import { parsePort } from './utils/port.js';
import { normaliseOrigin } from './utils/request-origin.js';
import { globalApiRateLimitMax } from './utils/global-rate-limit.js';
import { sessionOrAddressRateLimitKey } from './utils/rate-limit-key.js';

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

validateRuntimeEnv();

const app = Fastify({
  logger: apiLoggerOptionsForEnvironment(environment),
  trustProxy: trustedProxyAddresses.length > 0 ? trustedProxyAddresses : false,
});

// Plugins

await app.register(errorHandlerPlugin);
await app.register(securityHeadersPlugin);
await app.register(cookie);

await registerBrowserOriginProtection(app, allowedOrigins);

await app.register(rateLimit, {
  max: globalApiRateLimitMax(),
  timeWindow: '1 minute',
  // A signed-in session counts against itself rather than against the address
  // it came from, so a connector reading in a loop on the owner's machine
  // cannot spend the allowance the owner's browser needs on the same machine.
  // See utils/rate-limit-key.ts for why the signature is verified first.
  keyGenerator: sessionOrAddressRateLimitKey,
});

await app.register(multipart, {
  limits: DOCUMENT_UPLOAD_MULTIPART_LIMITS,
});

await app.register(prismaPlugin);

// Registered before the routes so its onResponse hook is in place for all of
// them. It records only unsafe requests from connector sessions, and it can
// never fail a request: the response has already been sent by the time it runs.
await app.register(clientActivityLogPlugin);

// A connector session's own budget for changing things, so an agent in a retry
// loop cannot spend the shared address allowance and lock the owner out of the
// web application running on the same machine.
await app.register(connectorWriteBudgetPlugin);

// A deployment that serves the owner console must have a distinct owner secret.
// Collapsing the two secrets would silently remove the isolation the console relies on.
if (isMultiTenant()) {
  assertOwnerJwtSecretConfigured();
}

// Routes

await app.register(authRoutes, { prefix: '/api/v1/auth' });
// Registered as its own scope so the non-browser guard and the absent
// cookie handling cannot leak into the browser auth routes beside it.
await app.register(connectorAuthRoutes, { prefix: '/api/v1/auth/connector' });
await app.register(organisationRoutes, { prefix: '/api/v1/organisation' });
await app.register(complianceRoutes, { prefix: '/api/v1/compliance' });
await app.register(boardMemberRoutes, { prefix: '/api/v1/board-members' });
await app.register(documentRoutes, { prefix: '/api/v1/documents' });
await app.register(deadlineRoutes, { prefix: '/api/v1/deadlines' });
await app.register(billingRoutes, { prefix: '/api/v1/billing' });
await app.register(exportRoutes, { prefix: '/api/v1/export' });
await app.register(dashboardRoutes, { prefix: '/api/v1/dashboard' });
await app.register(governanceRegisterRoutes, { prefix: '/api/v1/governance-registers' });
await app.register(governingActRoutes, { prefix: '/api/v1/governing-acts' });
await app.register(memberRoutes, { prefix: '/api/v1/members' });
await app.register(teamRoutes, { prefix: '/api/v1/team' });
await app.register(healthRoutes, { prefix: '/api/v1/health' });
await app.register(integrationRoutes, { prefix: INTEGRATION_ROUTES_PREFIX });
await app.register(ownerRoutes, { prefix: '/api/v1/owner' });

// Short-path alias: tell callers the right prefix rather than 404ing silently
app.get('/api/v1/risks', (_req, reply) => {
  reply.status(404).send({
    error: 'Not found',
    code: 'PATH_MOVED',
    message: 'Use /api/v1/governance-registers/risks',
  });
});

// Health check

// Start

const port = parsePort(process.env.PORT, 3002);
const host = process.env.HOST ?? '0.0.0.0';
let localAuthDeliveryTimer: NodeJS.Timeout | undefined;

try {
  await bindAuthRecoveryControlForRuntime(app.prisma);
  await app.listen({ port, host });
  app.log.info(`CharityPilot API running on http://${host}:${port}`);

  // Cron jobs
  const deadlineRemindersService = new DeadlineRemindersService(app.prisma);
  startCronJobs(deadlineRemindersService);
  if (environment !== 'production') {
    localAuthDeliveryTimer = startLocalAuthDeliveryCron(
      new AuthEmailDeliveryService(app.prisma),
    );
  }
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
    if (localAuthDeliveryTimer) clearInterval(localAuthDeliveryTimer);
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error(err, 'Graceful shutdown failed');
    process.exit(1);
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
