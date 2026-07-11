import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailService } from '../services/email.service.js';

type SentEmail = {
  from: string;
  to: string;
  subject: string;
  html: string;
};

type SendOptions = { idempotencyKey?: string; signal?: AbortSignal } | undefined;

type SendBehaviour = (message: SentEmail, options?: SendOptions) => Promise<unknown>;

type TestEmailLogger = {
  warn(message: string): void;
  error(message: string): void;
};

function captureEmailService(
  frontendUrl = 'https://app.example.org',
  sendBehaviour?: SendBehaviour,
  logger?: TestEmailLogger,
  deadlineReminderProviderTimeoutMs?: number,
) {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'noreply@example.org';
  process.env.FRONTEND_URL = frontendUrl;

  const sentMessages: SentEmail[] = [];
  const sentOptions: SendOptions[] = [];
  const service = logger
    ? new EmailService(logger, deadlineReminderProviderTimeoutMs)
    : new EmailService(undefined, deadlineReminderProviderTimeoutMs);
  (service as unknown as { resend: { emails: { send: (message: SentEmail, options?: SendOptions) => Promise<unknown> } } }).resend = {
    emails: {
      send: async (message: SentEmail, options?: SendOptions) => {
        sentMessages.push(message);
        sentOptions.push(options);
        return sendBehaviour
          ? sendBehaviour(message, options)
          : { data: { id: 'email_test_acceptance' }, error: null };
      },
    },
  };

  return {
    service,
    sent: () => {
      const sent = sentMessages.at(-1);
      assert.ok(sent, 'Expected email to be sent');
      return sent;
    },
    sentMessages: () => sentMessages,
    sentOptions: () => sentOptions,
  };
}

test('email send succeeds only when Resend returns a non-empty acceptance id', async () => {
  const { service } = captureEmailService();

  const delivered = await service.sendEmailVerification('owner@example.org', 'Owner', 'verify-token');

  assert.equal(delivered, true);
});

test('email send treats a resolved Resend error as failed and logs only sanitized diagnostics', async () => {
  const errors: string[] = [];
  const { service } = captureEmailService(
    'https://app.example.org',
    async () => ({
      data: null,
      error: {
        name: 'validation_error',
        message: 'Rejected owner@example.org token=raw-token re_live_secret-provider-payload',
        statusCode: 422,
      },
    }),
    {
      warn: () => undefined,
      error: (message) => errors.push(message),
    },
  );

  const delivered = await service.sendEmailVerification('owner@example.org', 'Owner', 'verify-token');

  assert.equal(delivered, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /name=validation_error/);
  assert.match(errors[0], /status=422/);
  assert.match(errors[0], /\[email\]/);
  assert.match(errors[0], /token=\[redacted\]/);
  assert.match(errors[0], /resend-key=\[redacted\]/);
  assert.doesNotMatch(errors[0], /owner@example\.org|raw-token|re_live_secret-provider-payload/);
  assert.doesNotMatch(errors[0], /"data"|"error"/);
});

test('email send rejects a malformed success response without leaking the response', async () => {
  const errors: string[] = [];
  const { service } = captureEmailService(
    'https://app.example.org',
    async () => ({ data: { id: '   ' }, error: null, rawPayload: 'provider-secret' }),
    {
      warn: () => undefined,
      error: (message) => errors.push(message),
    },
  );

  const delivered = await service.sendWelcomeEmail('owner@example.org', 'Owner', 'Good Works');

  assert.equal(delivered, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /name=InvalidProviderResponse/);
  assert.match(errors[0], /acceptance id/);
  assert.doesNotMatch(errors[0], /provider-secret|rawPayload/);
});

test('email send contains thrown provider failures and sanitizes their logs', async () => {
  const errors: string[] = [];
  const { service } = captureEmailService(
    'https://app.example.org',
    async () => {
      throw new Error('Network failure for owner@example.org token=raw-token re_test_secret');
    },
    {
      warn: () => undefined,
      error: (message) => errors.push(message),
    },
  );

  const delivered = await service.sendPasswordReset('owner@example.org', 'Owner', 'reset-token');

  assert.equal(delivered, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /name=Error/);
  assert.match(errors[0], /\[email\]/);
  assert.match(errors[0], /token=\[redacted\]/);
  assert.match(errors[0], /resend-key=\[redacted\]/);
  assert.doesNotMatch(errors[0], /owner@example\.org|raw-token|re_test_secret/);
});

test('welcome email escapes user-controlled HTML values', async () => {
  const { service, sent } = captureEmailService();

  await service.sendWelcomeEmail('owner@example.org', 'Ada <Admin>', 'Good Works & <script>alert(1)</script>');

  const { html } = sent();
  assert.equal(html.includes('Ada <Admin>'), false);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /Ada &lt;Admin&gt;/);
  assert.match(html, /Good Works &amp; &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('token emails put encoded tokens in URL fragments, not query strings', async () => {
  const { service, sent } = captureEmailService();
  const token = 'abc&next=<script>alert(1)</script>';

  await service.sendPasswordReset('owner@example.org', 'Ada <Admin>', token);

  const { html } = sent();
  assert.equal(html.includes(token), false);
  assert.equal(html.includes('Or paste this link into your browser:'), false);
  assert.doesNotMatch(html, /\?token=/);
  assert.match(html, /href="https:\/\/app\.example\.org\/reset-password#token=abc%26next%3D%3Cscript%3Ealert/);
  assert.match(html, /Ada &lt;Admin&gt;/);
});

test('outbound emails use the primary frontend origin when multiple browser origins are configured', async () => {
  const { service, sentMessages } = captureEmailService('https://app.example.org, https://admin.example.org');

  await service.sendWelcomeEmail('owner@example.org', 'Ada Admin', 'Good Works');
  await service.sendEmailVerification('owner@example.org', 'Ada Admin', 'verify-token');
  await service.sendPasswordReset('owner@example.org', 'Ada Admin', 'reset-token');
  await service.sendTeamInvite('owner@example.org', 'Good Works', 'Ada Admin', 'invite-token', 'ADMIN');
  await service.sendDeadlineReminder('owner@example.org', 'Good Works', {
    title: 'Annual report',
    dueDate: new Date('2026-07-01T00:00:00.000Z'),
    daysUntilDue: 14,
  }, { idempotencyKey: 'deadline-reminder/origin-test' });

  const html = sentMessages().map((message) => message.html).join('\n');
  assert.match(html, /href="https:\/\/app\.example\.org\/dashboard"/);
  assert.match(html, /href="https:\/\/app\.example\.org\/verify-email#token=verify-token"/);
  assert.match(html, /href="https:\/\/app\.example\.org\/reset-password#token=reset-token"/);
  assert.match(html, /href="https:\/\/app\.example\.org\/accept-invite#token=invite-token"/);
  assert.match(html, /href="https:\/\/app\.example\.org\/deadlines"/);
  assert.doesNotMatch(html, /admin\.example\.org/);
  assert.doesNotMatch(html, /,\s*https:\/\//);
});

test('deadline reminders forward a stable provider idempotency key without changing other email sends', async () => {
  const { service, sentOptions } = captureEmailService();

  await service.sendEmailVerification('owner@example.org', 'Owner', 'verify-token');
  const outcome = await service.sendDeadlineReminder('owner@example.org', 'Good Works', {
    title: 'Annual report',
    dueDate: new Date('2026-07-01T00:00:00.000Z'),
    daysUntilDue: 14,
  }, { idempotencyKey: 'deadline-reminder/test-key' });

  assert.equal(sentOptions()[0], undefined);
  assert.equal(sentOptions()[1]?.idempotencyKey, 'deadline-reminder/test-key');
  assert.ok(sentOptions()[1]?.signal instanceof AbortSignal);
  assert.equal(sentOptions()[1]?.signal?.aborted, false);
  assert.deepEqual(outcome, { outcome: 'ACCEPTED', providerMessageId: 'email_test_acceptance' });
});

test('deadline reminder aborts a never-resolving provider request and returns UNCERTAIN', async () => {
  let abortObserved = false;
  let lateAcceptanceAttempted = false;
  const { service } = captureEmailService(
    'https://app.example.org',
    async (_message, options) => new Promise((resolve, reject) => {
      const signal = options?.signal;
      assert.ok(signal, 'deadline reminder provider request must receive an abort signal');
      const rejectOnAbort = () => {
        abortObserved = true;
        reject(signal.reason);
        setTimeout(() => {
          lateAcceptanceAttempted = true;
          resolve({ data: { id: 'unsafe-late-acceptance' }, error: null });
        }, 5);
      };
      if (signal.aborted) rejectOnAbort();
      else signal.addEventListener('abort', rejectOnAbort, { once: true });
    }),
    undefined,
    10,
  );

  const startedAt = Date.now();
  const outcome = await service.sendDeadlineReminder(
    'owner@example.org',
    'Good Works',
    {
      title: 'Annual report',
      dueDate: new Date('2026-07-01T00:00:00.000Z'),
      daysUntilDue: 14,
    },
    { idempotencyKey: 'deadline-reminder/timeout' },
  );

  assert.deepEqual(outcome, { outcome: 'UNCERTAIN' });
  assert.equal(abortObserved, true);
  assert.ok(Date.now() - startedAt < 1_000, 'provider timeout must return within a bounded interval');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(lateAcceptanceAttempted, true, 'test provider must attempt a late acceptance after abort');
  assert.deepEqual(outcome, { outcome: 'UNCERTAIN' }, 'late provider settlement must not change the result');
});

test('deadline reminder abort signal reaches the installed Resend fetch request', async () => {
  const originalFetch = globalThis.fetch;
  let abortObserved = false;
  let lateFetchResolutionAttempted = false;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => (
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal, 'Resend must pass the application abort signal to fetch');
      const rejectOnAbort = () => {
        abortObserved = true;
        reject(signal.reason);
        setTimeout(() => {
          lateFetchResolutionAttempted = true;
          resolve(new Response(JSON.stringify({ id: 'unsafe-late-fetch-acceptance' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }));
        }, 5);
      };
      if (signal.aborted) rejectOnAbort();
      else signal.addEventListener('abort', rejectOnAbort, { once: true });
    })
  )) as typeof fetch;

  try {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM = 'noreply@example.org';
    process.env.FRONTEND_URL = 'https://app.example.org';
    const errors: string[] = [];
    const service = new EmailService({
      warn: () => undefined,
      error: (message) => errors.push(message),
    }, 10);

    const outcome = await service.sendDeadlineReminder(
      'owner@example.org',
      'Good Works',
      {
        title: 'Annual report',
        dueDate: new Date('2026-07-01T00:00:00.000Z'),
        daysUntilDue: 14,
      },
      { idempotencyKey: 'deadline-reminder/fetch-timeout' },
    );

    assert.deepEqual(outcome, { outcome: 'UNCERTAIN' });
    assert.equal(abortObserved, true);
    assert.equal(errors.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(lateFetchResolutionAttempted, true);
    assert.deepEqual(outcome, { outcome: 'UNCERTAIN' }, 'late fetch resolution must not change the result');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deadline reminder outcomes distinguish definite rejection from ambiguous acceptance', async () => {
  const deadline = {
    title: 'Annual report',
    dueDate: new Date('2026-07-01T00:00:00.000Z'),
    daysUntilDue: 14,
  };
  const definite = captureEmailService(
    'https://app.example.org',
    async () => ({
      data: null,
      error: { name: 'validation_error', message: 'Rejected', statusCode: 422 },
    }),
  );
  const ambiguous = captureEmailService(
    'https://app.example.org',
    async () => ({
      data: null,
      error: { name: 'internal_server_error', message: 'Unknown outcome', statusCode: 503 },
    }),
  );

  assert.deepEqual(
    await definite.service.sendDeadlineReminder(
      'owner@example.org',
      'Good Works',
      deadline,
      { idempotencyKey: 'deadline-reminder/definite' },
    ),
    { outcome: 'REJECTED' },
  );
  assert.deepEqual(
    await ambiguous.service.sendDeadlineReminder(
      'owner@example.org',
      'Good Works',
      deadline,
      { idempotencyKey: 'deadline-reminder/ambiguous' },
    ),
    { outcome: 'UNCERTAIN' },
  );
});

test('deadline reminder malformed, thrown and idempotency-conflict outcomes fail closed', async () => {
  const deadline = {
    title: 'Annual report',
    dueDate: new Date('2026-07-01T00:00:00.000Z'),
    daysUntilDue: 14,
  };
  const behaviours: SendBehaviour[] = [
    async () => ({ data: { id: '' }, error: null }),
    async () => {
      throw new Error('connection ended after request write');
    },
    async () => ({
      data: null,
      error: { name: 'concurrent_idempotent_requests', message: 'In progress', statusCode: 409 },
    }),
    async () => ({ data: null, error: { message: 'unclassified provider response' } }),
  ];

  for (const [index, behaviour] of behaviours.entries()) {
    const { service } = captureEmailService('https://app.example.org', behaviour);
    assert.deepEqual(
      await service.sendDeadlineReminder(
        'owner@example.org',
        'Good Works',
        deadline,
        { idempotencyKey: `deadline-reminder/uncertain-${index}` },
      ),
      { outcome: 'UNCERTAIN' },
    );
  }
});
