import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(process.cwd(), '..', '..');

function source(...parts: string[]): string {
  return readFileSync(resolve(repositoryRoot, ...parts), 'utf8');
}

const privacyPage = source('apps', 'web', 'src', 'app', '(marketing)', 'privacy', 'page.tsx');
const privacyCopy = privacyPage.replace(/\s+/g, ' ');
const prismaSchema = source('apps', 'api', 'prisma', 'schema.prisma');
const storageService = source('apps', 'api', 'src', 'services', 'storage.service.ts');
const authService = source('apps', 'api', 'src', 'services', 'auth.service.ts');
const sessionTokens = source('apps', 'api', 'src', 'services', 'session-tokens.ts');
const emailService = source('apps', 'api', 'src', 'services', 'email.service.ts');
const cookieNotice = source('apps', 'web', 'src', 'components', 'cookie-consent.tsx').replace(/\s+/g, ' ');

test('privacy copy matches the PostgreSQL, custom-auth, and private-storage boundaries', () => {
  assert.match(privacyCopy, /application records in PostgreSQL through Prisma/i);
  assert.match(privacyCopy, /implements its own authentication/i);
  assert.match(privacyCopy, /Supabase integration is used only for private document object storage/i);
  assert.match(privacyCopy, /Supabase Auth is not used/i);
  assert.doesNotMatch(privacyCopy, /Database hosting and authentication/i);

  assert.match(prismaSchema, /provider\s*=\s*"postgresql"/);
  assert.match(storageService, /createClient/);
  assert.match(storageService, /\.storage\s*\n?\s*\.from/);
  assert.match(authService, /bcrypt\.hash/);
  assert.match(sessionTokens, /refreshTokenHash/);
  assert.match(sessionTokens, /signAccessToken/);
});

test('privacy billing copy discloses stored Stripe state without inventing card fields', () => {
  assert.match(privacyCopy, /stores Stripe customer, subscription, and Checkout Session identifiers/i);
  assert.match(privacyCopy, /does not store card numbers, card last-four values, or billing names/i);
  assert.doesNotMatch(privacyCopy, /We store only the last four digits/i);

  for (const field of [
    'stripeCustomerId',
    'stripeSubscriptionId',
    'stripeCheckoutSessionId',
    'billingInterval',
    'cancelAtPeriodEnd',
  ]) {
    assert.match(prismaSchema, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(prismaSchema, /\b(?:cardLastFour|last4|billingName)\b/i);
});

test('privacy provider table does not fabricate hosting, regions, agreements, or safeguards', () => {
  assert.match(privacyCopy, /Listing an integration does not claim/i);
  assert.match(privacyCopy, /production account, data processing agreement, processing region/i);
  assert.match(privacyCopy, /Production providers and processing regions are not yet selected or configured/i);
  assert.doesNotMatch(privacyCopy, /SCCs in place/i);
  assert.doesNotMatch(privacyCopy, /EU \(Ireland\)/i);
  assert.doesNotMatch(privacyCopy, />Vercel</i);
  assert.doesNotMatch(privacyCopy, /Each is bound by a data processing agreement/i);
});

test('privacy purposes match implemented email and analytics behavior', () => {
  for (const method of [
    'sendWelcomeEmail',
    'sendEmailVerification',
    'sendPasswordRecoveryEmail',
    'sendPasswordResetCompletedNotice',
    'sendTeamInvite',
    'sendDeadlineReminder',
  ]) {
    assert.match(emailService, new RegExp(`\\b${method}\\b`));
  }

  assert.match(privacyCopy, /transactional welcome, email-verification, password-reset, team-invitation,/i);
  assert.match(privacyCopy, /does not currently implement marketing-email campaigns or page-view analytics/i);
  assert.doesNotMatch(privacyCopy, /payment receipts/i);
  assert.doesNotMatch(privacyCopy, /occasional product updates/i);
  assert.doesNotMatch(privacyCopy, /governance news/i);
  assert.doesNotMatch(privacyCopy, /analysing aggregated, anonymised usage patterns/i);
  assert.match(cookieNotice, /only.*strictly necessary authentication cookies/i);
  assert.match(cookieNotice, /does not set analytics or advertising cookies/i);
  assert.match(cookieNotice, /stores only a local browser preference/i);
  assert.match(cookieNotice, /Continue with essential cookies/i);
  assert.match(cookieNotice, /cookie-notice/i);
  assert.match(cookieNotice, /acknowledged/i);
  assert.match(cookieNotice, /Cookie information/i);
  assert.doesNotMatch(cookieNotice, /Accept All/i);
  assert.doesNotMatch(cookieNotice, /optional.*analytics cookies/i);
});

test('privacy retention, portability, security, and approval status stay fail-closed', () => {
  assert.match(privacyCopy, /Pre-launch draft - not approved for production/i);
  assert.match(privacyCopy, /final production data controller has not yet been formally approved/i);
  assert.match(privacyCopy, /Production legal bases have not yet been approved/i);
  assert.match(privacyCopy, /does not yet have an approved production retention schedule/i);
  assert.match(privacyCopy, /does not guarantee deletion within 30 days/i);
  assert.doesNotMatch(privacyCopy, /will be permanently deleted within 30 days/i);
  assert.doesNotMatch(privacyCopy, /will be retained for 7 years/i);
  assert.match(privacyCopy, /not a complete export of all personal data/i);
  assert.match(privacyCopy, /No production privacy contact channel has yet been verified/i);
  assert.match(privacyCopy, /Database and object-storage encryption at rest.*must be verified/i);
  assert.doesNotMatch(privacyCopy, /encryption at rest in our database/i);
});
