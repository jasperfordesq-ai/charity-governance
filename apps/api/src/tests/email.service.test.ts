import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailService } from '../services/email.service.js';

type SentEmail = {
  from: string;
  to: string;
  subject: string;
  html: string;
};

type SendBehaviour = (message: SentEmail) => Promise<unknown>;

type TestEmailLogger = {
  warn(message: string): void;
  error(message: string): void;
};

function captureEmailService(
  frontendUrl = 'https://app.example.org',
  sendBehaviour?: SendBehaviour,
  logger?: TestEmailLogger,
) {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'noreply@example.org';
  process.env.FRONTEND_URL = frontendUrl;

  const sentMessages: SentEmail[] = [];
  const service = logger ? new EmailService(logger) : new EmailService();
  (service as unknown as { resend: { emails: { send: (message: SentEmail) => Promise<unknown> } } }).resend = {
    emails: {
      send: async (message: SentEmail) => {
        sentMessages.push(message);
        return sendBehaviour
          ? sendBehaviour(message)
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
  });

  const html = sentMessages().map((message) => message.html).join('\n');
  assert.match(html, /href="https:\/\/app\.example\.org\/dashboard"/);
  assert.match(html, /href="https:\/\/app\.example\.org\/verify-email#token=verify-token"/);
  assert.match(html, /href="https:\/\/app\.example\.org\/reset-password#token=reset-token"/);
  assert.match(html, /href="https:\/\/app\.example\.org\/accept-invite#token=invite-token"/);
  assert.match(html, /href="https:\/\/app\.example\.org\/deadlines"/);
  assert.doesNotMatch(html, /admin\.example\.org/);
  assert.doesNotMatch(html, /,\s*https:\/\//);
});
