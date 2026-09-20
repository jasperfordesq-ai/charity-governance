import { PrismaClient } from '@prisma/client';
import { DocumentPublicationService } from '../services/document-publication.service.js';
import { createConfluenceReconciler } from '../services/confluence-reconcile.service.js';
import { validateDocumentStorageCleanupEnv } from '../utils/env.js';
import { logSchedulerError, runDocumentReconcile } from './production-scheduler.js';

/**
 * The standalone reconcile worker, for a deployment that runs jobs from cron
 * rather than the in-process scheduler.
 *
 * **Both entry points exist and both must register the reconciler.** Phase 5
 * shipped a phase that was dead in production because only one of its two entry
 * points was wired: the code was correct, tested, and never ran. This file and
 * `production-scheduler.ts` are pinned separately, so losing either fails its
 * own test.
 *
 * It reuses the document-storage cleanup validator rather than declaring a
 * near-identical one, for the reason `publish-document-mirrors.ts` gives: two
 * validators meant to say the same thing are two validators that can come to
 * disagree. It needs strictly less than that job does — no storage backend,
 * because nothing here reads a document's bytes. Reconcile only ever *reads*
 * Confluence.
 *
 * NOTE FOR ANYONE SCHEDULING THIS FROM CRON: the interval is a budget decision.
 * Atlassian meters one hourly points pool across every tenant of the app, and
 * this worker has no way to know another copy of itself is running. Six-hourly
 * is the in-process default; running it every few minutes would spend the whole
 * estate's budget on a question nobody is waiting for the answer to.
 */

process.env.NODE_ENV ??= 'production';
validateDocumentStorageCleanupEnv();

const prisma = new PrismaClient();
const logger = console;

function positiveIntegerEnv(value: string | undefined, fallback: number): number {
  const configured = Number(value);
  return Number.isInteger(configured) && configured > 0 ? configured : fallback;
}

try {
  const publicationService = new DocumentPublicationService(prisma);
  const reconcile = createConfluenceReconciler({ prisma });

  const failed = await runDocumentReconcile({
    prisma,
    publicationService,
    reconcile,
    tenantsPerRun: positiveIntegerEnv(process.env.DOCUMENT_RECONCILE_TENANTS_PER_RUN, 10),
    pagesPerRun: positiveIntegerEnv(process.env.DOCUMENT_RECONCILE_PAGES_PER_RUN, 50),
    minPageAgeMs: positiveIntegerEnv(
      process.env.DOCUMENT_RECONCILE_MIN_PAGE_AGE_MS,
      24 * 60 * 60 * 1000,
    ),
    logger,
  });

  if (failed) process.exitCode = 1;
} catch (error) {
  // `runDocumentReconcile` already alerts on its own failures, so reaching here
  // means something outside it threw — building the client, or the Prisma
  // connection itself. Logged and exited non-zero rather than alerted twice.
  logSchedulerError(logger, 'Document reconcile job failed outside its runner:', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
