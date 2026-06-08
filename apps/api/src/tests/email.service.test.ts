import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailService } from '../services/email.service.js';

type SentEmail = {
  from: string;
  to: string;
  subject: string;
  html: string;
};

function captureEmailService(frontendUrl = 'https://app.example.org') {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'noreply@example.org';
  process.env.FRONTEND_URL = frontendUrl;

  const sentMessages: SentEmail[] = [];
  const service = new EmailService();
  (service as unknown as { resend: { emails: { send: (message: SentEmail) => Promise<unknown> } } }).resend = {
    emails: {
      send: async (message: SentEmail) => {
        sentMessages.push(message);
        return {};
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
