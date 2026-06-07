import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailService } from '../services/email.service.js';

type SentEmail = {
  from: string;
  to: string;
  subject: string;
  html: string;
};

function captureEmailService() {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'noreply@example.org';
  process.env.FRONTEND_URL = 'https://app.example.org';

  let sent: SentEmail | undefined;
  const service = new EmailService();
  (service as unknown as { resend: { emails: { send: (message: SentEmail) => Promise<unknown> } } }).resend = {
    emails: {
      send: async (message: SentEmail) => {
        sent = message;
        return {};
      },
    },
  };

  return {
    service,
    sent: () => {
      assert.ok(sent, 'Expected email to be sent');
      return sent;
    },
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
