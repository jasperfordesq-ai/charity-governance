import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const [{ default: Fastify }, { healthRoutes }, { manualInviteUrl }] = await Promise.all([
  import('fastify'),
  import('../routes/health/index.js'),
  import('../utils/deployment-profile.js'),
]);

// Every env var either the deployment-profile axes or the provider checks
// (billing/email/storage) read, so each test starts from a clean slate and
// restores whatever was there before it ran.
const ENV_KEYS = [
  'NODE_ENV',
  'CHARITYPILOT_DEPLOYMENT_MODE',
  'CHARITYPILOT_EMAIL_DELIVERY',
  'CHARITYPILOT_BILLING',
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
  'FRONTEND_URL',
  'NEXT_PUBLIC_API_URL',
] as const;

async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withCleanEnv(
  vars: Record<string, string | undefined>,
  run: () => Promise<void>,
) {
  const cleared = Object.fromEntries(ENV_KEYS.map((key) => [key, undefined]));
  await withEnv({ ...cleared, ...vars }, run);
}

async function buildHealthAppWithLocalStorage(): Promise<{
  app: Awaited<ReturnType<typeof Fastify>>;
  cleanup: () => Promise<void>;
}> {
  const storageRoot = await mkdtemp(join(tmpdir(), 'charitypilot-provider-readiness-'));
  process.env.DOCUMENT_STORAGE_DRIVER = 'local';
  process.env.LOCAL_FILE_STORAGE_DIR = storageRoot;
  process.env.READINESS_API_KEY = 'provider-readiness-test-secret';

  const app = Fastify({ logger: false });
  app.decorate('prisma', {
    $queryRaw: async () => [{ '?column?': 1 }],
    $transaction: async () => ({ id: 1 }),
  } as never);
  await app.register(healthRoutes, { prefix: '/api/v1/health' });

  return {
    app,
    cleanup: async () => {
      await app.close();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

async function readiness(app: Awaited<ReturnType<typeof Fastify>>) {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/health/readiness',
    headers: { 'x-charitypilot-readiness-key': 'provider-readiness-test-secret' },
  });
  return { statusCode: response.statusCode, body: response.json() };
}

test('health: manual-link + billing none => provider checks exempt', { concurrency: false }, async () => {
  await withCleanEnv(
    {
      CHARITYPILOT_EMAIL_DELIVERY: 'manual-link',
      CHARITYPILOT_BILLING: 'none',
    },
    async () => {
      const { app, cleanup } = await buildHealthAppWithLocalStorage();
      try {
        const { statusCode, body } = await readiness(app);

        assert.equal(body.checks.billingConfigured, false);
        assert.equal(body.checks.emailConfigured, false);
        assert.equal(statusCode, 200);
        assert.equal(body.status, 'ready');
      } finally {
        await cleanup();
      }
    },
  );
});

test('health: provider email missing config still blocks readiness in default mode', { concurrency: false }, async () => {
  await withCleanEnv({}, async () => {
    const { app, cleanup } = await buildHealthAppWithLocalStorage();
    try {
      const { statusCode, body } = await readiness(app);

      assert.equal(body.checks.billingConfigured, false);
      assert.equal(body.checks.emailConfigured, false);
      assert.equal(statusCode, 503);
      assert.equal(body.status, 'not_ready');
    } finally {
      await cleanup();
    }
  });
});

test(
  'health APPLIANCE COMPATIBILITY: personal-server mode, no vars => providers exempt (as today)',
  { concurrency: false },
  async () => {
    await withCleanEnv(
      {
        CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
      },
      async () => {
        const { app, cleanup } = await buildHealthAppWithLocalStorage();
        try {
          const { statusCode, body } = await readiness(app);

          assert.equal(body.checks.billingConfigured, false);
          assert.equal(body.checks.emailConfigured, false);
          assert.equal(statusCode, 200);
          assert.equal(body.status, 'ready');
        } finally {
          await cleanup();
        }
      },
    );
  },
);

test('manualInviteUrl uses the personal-server origin in appliance mode', () => {
  const url = manualInviteUrl('tok123', {
    CHARITYPILOT_DEPLOYMENT_MODE: 'personal-server',
    FRONTEND_URL: 'https://charitypilot.tail.example.ts.net',
    NEXT_PUBLIC_API_URL: 'https://charitypilot.tail.example.ts.net',
  });
  assert.equal(url, 'https://charitypilot.tail.example.ts.net/accept-invite#token=tok123');
});

test('manualInviteUrl falls back to FRONTEND_URL outside appliance mode', () => {
  const url = manualInviteUrl('tok123', { FRONTEND_URL: 'https://charitypilot.tail.example.ts.net' });
  assert.equal(url, 'https://charitypilot.tail.example.ts.net/accept-invite#token=tok123');
});

test('manualInviteUrl returns null with no usable origin, and never puts the token in the query string', () => {
  assert.equal(manualInviteUrl('tok123', {}), null);
  const url = manualInviteUrl('tok123', { FRONTEND_URL: 'https://x.example' });
  assert.ok(url && !url.includes('?token='), 'token must ride the fragment');
});
