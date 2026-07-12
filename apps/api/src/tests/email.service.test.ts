import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { EmailService } from '../services/email.service.js';
import {
  renderPasswordRecoverySecurityEmailV1,
  renderPasswordResetCompletedNoticeV1,
} from '../services/security-email-templates.js';

type SentEmail = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
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
  securityEmailProviderTimeoutMs?: number,
) {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'noreply@example.org';
  process.env.FRONTEND_URL = frontendUrl;

  const sentMessages: SentEmail[] = [];
  const sentOptions: SendOptions[] = [];
  const service = logger
    ? new EmailService(logger, deadlineReminderProviderTimeoutMs, securityEmailProviderTimeoutMs)
    : new EmailService(undefined, deadlineReminderProviderTimeoutMs, securityEmailProviderTimeoutMs);
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

function renderedEmailHash(rendered: { subject: string; html: string; text: string }): string {
  return createHash('sha256').update(JSON.stringify(rendered)).digest('hex');
}

test('security email v1 renderers are deterministic and pinned byte-for-byte', () => {
  const recovery = renderPasswordRecoverySecurityEmailV1({
    recipientName: 'Ada <Admin>',
    token: 'token-&-value',
    frontendOrigin: 'https://snapshot.example.org',
  });
  const notice = renderPasswordResetCompletedNoticeV1({
    recipientName: 'Ada <Admin>',
    changedAt: new Date('2026-07-11T12:34:00.000Z'),
  });

  assert.equal(
    renderedEmailHash(recovery),
    '97cd30166e3324440f0086218082070a5514d10911b5fca1a7a7814d08bb2ffe',
  );
  assert.equal(
    renderedEmailHash(notice),
    '1d3df10ba080d2bce8e91b1da7725af4a69b6d98c6619ef8370268efdd677609',
  );
  assert.deepEqual(
    renderPasswordRecoverySecurityEmailV1({
      recipientName: 'Ada <Admin>',
      token: 'token-&-value',
      frontendOrigin: 'https://snapshot.example.org',
    }),
    recovery,
  );
  assert.deepEqual(
    renderPasswordResetCompletedNoticeV1({
      recipientName: 'Ada <Admin>',
      changedAt: new Date('2026-07-11T12:34:00.000Z'),
    }),
    notice,
  );
  assert.doesNotMatch(recovery.html, /new Date|2025|2026|2027/);
  assert.match(
    recovery.text,
    /https:\/\/snapshot\.example\.org\/reset-password#token=token-%26-value/,
  );
  assert.match(notice.html, /11 July 2026 at 12:34 UTC/);
  assert.match(notice.text, /authorised organisation administrator immediately/);
  assert.doesNotMatch(notice.text, /CharityPilot support/i);
});

test('unsupported security email template versions fail before provider I/O', async () => {
  const { service, sentMessages } = captureEmailService();

  await assert.rejects(
    () => service.sendPasswordRecoveryEmail(
      'owner@example.org',
      'Owner',
      'reset-token',
      {
        idempotencyKey: 'charitypilot-password-recovery-v2:unsupported',
        templateVersion: 2,
      },
    ),
    /Unsupported password recovery email template version: 2/,
  );
  await assert.rejects(
    () => service.sendPasswordResetCompletedNotice(
      'owner@example.org',
      'Owner',
      new Date('2026-07-11T12:34:00.000Z'),
      {
        idempotencyKey: 'charitypilot-security-email-v2:unsupported',
        templateVersion: 2,
      },
    ),
    /Unsupported password reset notice template version: 2/,
  );
  assert.equal(sentMessages().length, 0);
});

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
      throw new Error(
        'Network failure for owner@example.org token=raw-token link=https://app.example.org/reset-password#token=raw-fragment-capability re_test_secret',
      );
    },
    {
      warn: () => undefined,
      error: (message) => errors.push(message),
    },
  );

  const delivered = await service.sendPasswordRecoveryEmail(
    'owner@example.org',
    'Owner',
    'reset-token',
    {
      idempotencyKey: 'charitypilot-password-recovery-v1:thrown-provider',
      templateVersion: 1,
    },
  );

  assert.deepEqual(delivered, { outcome: 'UNCERTAIN' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /name=Error/);
  assert.match(errors[0], /\[email\]/);
  assert.match(errors[0], /token=\[redacted\]/);
  assert.match(errors[0], /resend-key=\[redacted\]/);
  assert.doesNotMatch(
    errors[0],
    /owner@example\.org|raw-token|raw-fragment-capability|re_test_secret/,
  );
});

test('password recovery email returns typed acceptance and freezes the exact idempotency key and origin', async () => {
  const { service, sent, sentOptions } = captureEmailService('https://current.example.org');

  const outcome = await service.sendPasswordRecoveryEmail(
    'owner@example.org',
    'Owner',
    'reset-token',
    {
      idempotencyKey: 'charitypilot-password-recovery-v1:request-1',
      templateVersion: 1,
      frontendOrigin: 'https://requested.example.org',
    },
  );

  assert.deepEqual(outcome, {
    outcome: 'ACCEPTED',
    providerMessageId: 'email_test_acceptance',
  });
  assert.equal(
    sentOptions()[0]?.idempotencyKey,
    'charitypilot-password-recovery-v1:request-1',
  );
  assert.ok(sentOptions()[0]?.signal instanceof AbortSignal);
  assert.match(
    sent().html,
    /href="https:\/\/requested\.example\.org\/reset-password#token=reset-token"/,
  );
  assert.match(
    sent().text ?? '',
    /https:\/\/requested\.example\.org\/reset-password#token=reset-token/,
  );
  assert.doesNotMatch(sent().html, /current\.example\.org/);
});

test('security email outcomes distinguish definite, retryable and ambiguous provider failures', async () => {
  const cases: Array<{
    error: Record<string, unknown>;
    expected: unknown;
  }> = [
    {
      error: { name: 'validation_error', statusCode: 422, message: 'invalid sender' },
      expected: { outcome: 'REJECTED', retryable: false },
    },
    {
      error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'slow down' },
      expected: { outcome: 'REJECTED', retryable: true },
    },
    {
      error: { name: 'concurrent_idempotent_requests', statusCode: 409, message: 'in progress' },
      expected: { outcome: 'UNCERTAIN' },
    },
    {
      error: { name: 'internal_server_error', statusCode: 503, message: 'unknown outcome' },
      expected: { outcome: 'UNCERTAIN' },
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const { service } = captureEmailService(
      'https://app.example.org',
      async () => ({ data: null, error: testCase.error }),
    );
    assert.deepEqual(
      await service.sendPasswordRecoveryEmail(
        'owner@example.org',
        'Owner',
        'reset-token',
        {
          idempotencyKey: `charitypilot-password-recovery-v1:failure-${index}`,
          templateVersion: 1,
        },
      ),
      testCase.expected,
    );
  }
});

test('security email timeout is bounded, classified uncertain and cannot be changed by late acceptance', async () => {
  let abortObserved = false;
  let lateAcceptanceAttempted = false;
  const { service } = captureEmailService(
    'https://app.example.org',
    async (_message, options) => new Promise((resolve) => {
      const signal = options?.signal;
      assert.ok(signal);
      const observeAbort = () => {
        abortObserved = true;
        // Deliberately ignore cancellation to prove the application-owned race,
        // rather than provider/fetch cooperation, enforces the deadline.
        setTimeout(() => {
          lateAcceptanceAttempted = true;
          resolve({ data: { id: 'unsafe-late-acceptance' }, error: null });
        }, 5);
      };
      if (signal.aborted) observeAbort();
      else signal.addEventListener('abort', observeAbort, { once: true });
    }),
    undefined,
    undefined,
    10,
  );

  const outcome = await service.sendPasswordRecoveryEmail(
    'owner@example.org',
    'Owner',
    'reset-token',
    {
      idempotencyKey: 'charitypilot-password-recovery-v1:timeout',
      templateVersion: 1,
    },
  );

  assert.deepEqual(outcome, { outcome: 'UNCERTAIN' });
  assert.equal(abortObserved, true);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(lateAcceptanceAttempted, true);
  assert.deepEqual(outcome, { outcome: 'UNCERTAIN' });
});

test('password reset completion notice contains no password or recovery capability', async () => {
  const { service, sent, sentOptions } = captureEmailService();

  const outcome = await service.sendPasswordResetCompletedNotice(
    'owner@example.org',
    'Owner',
    new Date('2026-07-11T12:34:00.000Z'),
    {
      idempotencyKey: 'charitypilot-security-email-v1:notice-1',
      templateVersion: 1,
    },
  );

  assert.equal(outcome.outcome, 'ACCEPTED');
  assert.equal(
    sentOptions()[0]?.idempotencyKey,
    'charitypilot-security-email-v1:notice-1',
  );
  assert.match(sent().subject, /password was changed/i);
  assert.match(sent().html, /All existing CharityPilot sessions/);
  assert.match(sent().html, /11 July 2026/);
  assert.match(sent().text ?? '', /11 July 2026 at 12:34 UTC/);
  assert.match(sent().text ?? '', /authorised organisation administrator immediately/);
  assert.doesNotMatch(sent().html, /reset-token|#token=|\?token=|NewPassword/i);
  assert.doesNotMatch(sent().text ?? '', /reset-token|#token=|\?token=|NewPassword/i);
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

  await service.sendPasswordRecoveryEmail(
    'owner@example.org',
    'Ada <Admin>',
    token,
    {
      idempotencyKey: 'charitypilot-password-recovery-v1:fragment-test',
      templateVersion: 1,
    },
  );

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
  await service.sendPasswordRecoveryEmail(
    'owner@example.org',
    'Ada Admin',
    'reset-token',
    {
      idempotencyKey: 'charitypilot-password-recovery-v1:origin-test',
      templateVersion: 1,
    },
  );
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
