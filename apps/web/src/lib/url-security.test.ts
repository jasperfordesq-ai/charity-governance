import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSensitiveUrlToken,
  getTrustedDocumentDownloadUrl,
  getTrustedStripeRedirectUrl,
  removeSensitiveSearchParams,
} from './url-security';

test('removes sensitive token query parameters while preserving safe URL parts', () => {
  assert.equal(
    removeSensitiveSearchParams(
      'https://charitypilot.ie/reset-password?token=secret&utm_source=email#form',
      ['token'],
    ),
    'https://charitypilot.ie/reset-password?utm_source=email#form',
  );
});

test('removes the query marker when sensitive parameters were the only query parameters', () => {
  assert.equal(
    removeSensitiveSearchParams('https://charitypilot.ie/verify-email?token=secret', ['token']),
    'https://charitypilot.ie/verify-email',
  );
});

test('extracts sensitive tokens from URL fragments before query strings are logged', () => {
  assert.equal(
    getSensitiveUrlToken('https://charitypilot.ie/reset-password#token=secret%26encoded', 'token'),
    'secret&encoded',
  );
});

test('prefers fragment tokens over query tokens for sensitive auth links', () => {
  assert.equal(
    getSensitiveUrlToken('https://charitypilot.ie/reset-password?token=query-token#token=fragment-token', 'token'),
    'fragment-token',
  );
});

test('scrubs sensitive token parameters from URL fragments', () => {
  assert.equal(
    removeSensitiveSearchParams('https://charitypilot.ie/reset-password#token=secret&step=confirm', ['token']),
    'https://charitypilot.ie/reset-password#step=confirm',
  );
});

test('trusts only hosted Stripe https redirect origins', () => {
  assert.equal(
    getTrustedStripeRedirectUrl('https://checkout.stripe.com/c/session-id'),
    'https://checkout.stripe.com/c/session-id',
  );
  assert.equal(
    getTrustedStripeRedirectUrl('https://billing.stripe.com/session/account'),
    'https://billing.stripe.com/session/account',
  );
  assert.equal(getTrustedStripeRedirectUrl('http://checkout.stripe.com/c/session-id'), null);
  assert.equal(getTrustedStripeRedirectUrl('https://checkout.stripe.com.evil.test/c/session-id'), null);
  assert.equal(getTrustedStripeRedirectUrl('javascript:alert(1)'), null);
});

test('trusts document downloads only from https expected origins or Supabase storage', () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://configured-project.supabase.co';

  assert.equal(
    getTrustedDocumentDownloadUrl('https://configured-project.supabase.co/storage/v1/object/sign/documents/a.pdf'),
    'https://configured-project.supabase.co/storage/v1/object/sign/documents/a.pdf',
  );
  assert.equal(
    getTrustedDocumentDownloadUrl('https://files.charitypilot.ie/download/a.pdf', {
      allowedOrigins: ['https://files.charitypilot.ie'],
    }),
    'https://files.charitypilot.ie/download/a.pdf',
  );
  assert.equal(
    getTrustedDocumentDownloadUrl('http://configured-project.supabase.co/storage/v1/object/sign/documents/a.pdf'),
    null,
  );
  assert.equal(getTrustedDocumentDownloadUrl('https://evil.test/download/a.pdf'), null);
  assert.equal(
    getTrustedDocumentDownloadUrl('https://attacker.supabase.co/storage/v1/object/sign/documents/a.pdf'),
    null,
  );
});
