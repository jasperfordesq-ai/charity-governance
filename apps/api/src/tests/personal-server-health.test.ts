import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { healthRoutes } from '../routes/health/index.js';

const ENV_KEYS = [
  'NODE_ENV',
  'CHARITYPILOT_DEPLOYMENT_MODE',
  'READINESS_API_KEY',
  'DOCUMENT_STORAGE_DRIVER',
  'LOCAL_FILE_STORAGE_DIR',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_BILLING_PORTAL_CONFIGURATION_ID',
  'STRIPE_ESSENTIALS_MONTHLY_PRICE_ID',
  'STRIPE_ESSENTIALS_YEARLY_PRICE_ID',
  'STRIPE_COMPLETE_MONTHLY_PRICE_ID',
  'STRIPE_COMPLETE_YEARLY_PRICE_ID',
  'RESEND_API_KEY',
] as const;

test('personal-server readiness requires database and local storage but reports disabled billing/email without blocking startup', { concurrency: false }, async () => {
  const before = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const storageRoot = await mkdtemp(join(tmpdir(), 'charitypilot-personal-readiness-'));
  const app = Fastify({ logger: false });
  app.decorate('prisma', { $queryRaw: async () => [{ '?column?': 1 }] } as never);

  try {
    process.env.NODE_ENV = 'production';
    process.env.CHARITYPILOT_DEPLOYMENT_MODE = 'personal-server';
    process.env.READINESS_API_KEY = 'personal-readiness-test-secret';
    process.env.DOCUMENT_STORAGE_DRIVER = 'local';
    process.env.LOCAL_FILE_STORAGE_DIR = storageRoot;
    for (const key of ENV_KEYS.filter((entry) => entry.startsWith('STRIPE_') || entry === 'RESEND_API_KEY')) {
      delete process.env[key];
    }

    await app.register(healthRoutes, { prefix: '/api/v1/health' });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health/readiness',
      headers: { 'x-charitypilot-readiness-key': 'personal-readiness-test-secret' },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().checks, {
      database: true,
      billingConfigured: false,
      emailConfigured: false,
      storageConfigured: true,
      storageBucketReachable: true,
    });
  } finally {
    await app.close();
    await rm(storageRoot, { recursive: true, force: true });
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
