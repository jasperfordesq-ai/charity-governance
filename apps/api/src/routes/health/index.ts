import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BillingService } from '../../services/billing.service.js';
import { EmailService } from '../../services/email.service.js';
import { StorageService, withReadinessTimeout } from '../../services/storage.service.js';
import { isConfiguredSecret } from '../../utils/env.js';

const READINESS_HEADER = 'x-charitypilot-readiness-key';

function hasReadinessAccess(request: FastifyRequest): boolean {
  const configuredKey = process.env.READINESS_API_KEY;
  if (!isConfiguredSecret(configuredKey)) return false;

  const suppliedKey = request.headers[READINESS_HEADER];
  return typeof suppliedKey === 'string' && suppliedKey === configuredKey;
}

function readinessDependencyTimeoutMs(): number {
  const configured = Number(process.env.READINESS_DEPENDENCY_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : 3000;
}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  app.get('/readiness', async (request, reply) => {
    if (!hasReadinessAccess(request)) {
      return reply.status(401).send({
        error: 'Readiness details require an internal readiness key',
        code: 'READINESS_UNAUTHORIZED',
      });
    }

    const billing = new BillingService(app.prisma);

    let database = false;
    try {
      const result = await withReadinessTimeout(app.prisma.$queryRaw`SELECT 1`, readinessDependencyTimeoutMs());
      database = result !== null;
    } catch (err) {
      request.log.error(err, 'Readiness database check failed');
    }

    let emailConfigured = false;
    try {
      emailConfigured = new EmailService().isConfigured();
    } catch (err) {
      request.log.error(err, 'Readiness email configuration check failed');
    }

    const storage = new StorageService();
    const checks = {
      database,
      billingConfigured: billing.isConfigured(),
      emailConfigured,
      storageConfigured: storage.isConfigured(),
      storageBucketReachable: await storage.verifyBucket(),
    };

    const ready =
      database &&
      checks.billingConfigured &&
      checks.emailConfigured &&
      checks.storageConfigured &&
      checks.storageBucketReachable;

    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks,
      timestamp: new Date().toISOString(),
    });
  });
}
