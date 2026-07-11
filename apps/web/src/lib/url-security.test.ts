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

test('trusts only the exact authenticated download route on the expected CharityPilot API origin', () => {
  assert.equal(
    getTrustedDocumentDownloadUrl('https://api.charitypilot.ie/api/v1/documents/doc-1/download'),
    'https://api.charitypilot.ie/api/v1/documents/doc-1/download',
  );
  assert.equal(
    getTrustedDocumentDownloadUrl('https://configured-project.supabase.co/storage/v1/object/sign/documents/a.pdf?token=secret'),
    null,
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
  assert.equal(
    getTrustedDocumentDownloadUrl('https://files.charitypilot.ie/api/v1/documents/doc-1/download'),
    null,
  );
  assert.equal(
    getTrustedDocumentDownloadUrl('https://api.charitypilot.ie/api/v1/documents/doc-1/download?token=secret'),
    null,
  );
  assert.equal(
    getTrustedDocumentDownloadUrl('https://api.charitypilot.ie/api/v1/billing/checkout'),
    null,
  );
});

test('trusts authenticated local API document downloads only on loopback in development', () => {
  assert.equal(
    getTrustedDocumentDownloadUrl('http://localhost:3002/api/v1/documents/doc-1/download'),
    'http://localhost:3002/api/v1/documents/doc-1/download',
  );
  assert.equal(
    getTrustedDocumentDownloadUrl('http://127.0.0.1:3002/api/v1/documents/doc-1/download'),
    'http://127.0.0.1:3002/api/v1/documents/doc-1/download',
  );
  assert.equal(
    getTrustedDocumentDownloadUrl('http://localhost:3002/api/v1/documents/_local-download?path=org-1%2Fpolicy.pdf'),
    null,
  );
  assert.equal(
    getTrustedDocumentDownloadUrl('http://localhost:3002/api/v1/billing/checkout'),
    null,
  );
  assert.equal(
    getTrustedDocumentDownloadUrl('http://evil.test/api/v1/documents/doc-1/download'),
    null,
  );
});

test('isolated production trusts only the exact managed-runner document origin and marker', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousE2eMode = process.env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE;
  try {
    process.env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE = 'local-disposable';
    assert.equal(
      getTrustedDocumentDownloadUrl('http://127.0.0.1:3302/api/v1/documents/doc-1/download'),
      'http://127.0.0.1:3302/api/v1/documents/doc-1/download',
    );
    assert.equal(
      getTrustedDocumentDownloadUrl('http://localhost:3302/api/v1/documents/doc-1/download'),
      null,
    );
    assert.equal(
      getTrustedDocumentDownloadUrl('http://127.0.0.1:3002/api/v1/documents/doc-1/download'),
      null,
    );
    assert.equal(
      getTrustedDocumentDownloadUrl('http://127.0.0.1:3302/api/v1/documents/doc-1/download?token=secret'),
      null,
    );

    process.env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE = 'local-disposable-lookalike';
    assert.equal(
      getTrustedDocumentDownloadUrl('http://127.0.0.1:3302/api/v1/documents/doc-1/download'),
      null,
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousE2eMode === undefined) delete process.env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE;
    else process.env.NEXT_PUBLIC_CHARITYPILOT_E2E_MODE = previousE2eMode;
  }
});
