import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { AuthEmailDeliveryService } from '../services/auth-email-delivery.service.js';
import { requireAuthRecoveryControlForRuntime } from '../services/auth-recovery-control.js';
import { validateAuthDeliveryEnv } from '../utils/env.js';
import { serializeErrorForLog } from '../utils/logger.js';
import { productionSchedulerConfigFromEnv } from './production-scheduler.js';

export async function processAuthEmailDeliveryOnce(): Promise<void> {
  process.env.NODE_ENV ??= 'production';
  validateAuthDeliveryEnv();
  const config = productionSchedulerConfigFromEnv();
  const prisma = new PrismaClient();
  try {
    await requireAuthRecoveryControlForRuntime(prisma);
    const result = await new AuthEmailDeliveryService(prisma).processDueDeliveries({
      limit: config.authDeliveryBatchSize,
      cleanupLimit: config.authDeliveryCleanupBatchSize,
      staleSendingMs: config.authDeliveryStaleSendingMs,
    });
    process.stdout.write(
      `[AuthEmailDelivery] completed processed=${result.processed} accepted=${result.accepted} retryScheduled=${result.retryScheduled} rejected=${result.rejected} uncertain=${result.uncertain} keyUnavailable=${result.keyUnavailable} staleQuarantined=${result.staleQuarantined} cleaned=${result.cleaned}\n`,
    );
    if (
      result.rejected > 0 ||
      result.uncertain > 0 ||
      result.keyUnavailable > 0 ||
      result.staleQuarantined > 0
    ) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  processAuthEmailDeliveryOnce().catch((error: unknown) => {
    process.stderr.write(
      `[AuthEmailDelivery] failed ${JSON.stringify(serializeErrorForLog(error))}\n`,
    );
    process.exitCode = 1;
  });
}
