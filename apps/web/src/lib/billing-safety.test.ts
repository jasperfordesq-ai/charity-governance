import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = process.cwd();
const readWebSource = (...parts: string[]) => readFileSync(join(WEB, 'src', ...parts), 'utf8');
const billingPage = readWebSource('app', '(dashboard)', 'billing', 'page.tsx');
const planSections = readWebSource('app', '(dashboard)', 'billing', 'billing-plan-sections.tsx');
const pricingPage = readWebSource('app', '(marketing)', 'pricing', 'page.tsx');
const sharedApiTypes = readFileSync(
  join(WEB, '..', '..', 'packages', 'shared', 'src', 'types', 'api.ts'),
  'utf8',
);

test('billing status exposes explicit server-owned checkout and portal capabilities', () => {
  const statusContract = sharedApiTypes.match(/export interface BillingStatusResponse \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(statusContract, /canStartCheckout: boolean;/);
  assert.match(statusContract, /canOpenPortal: boolean;/);
});

test('billing page fails closed before calling checkout or portal endpoints', () => {
  assert.match(
    billingPage,
    /if \(!billing\?\.canStartCheckout\) \{[\s\S]*?return;[\s\S]*?api\.post\('\/billing\/checkout'/,
  );
  assert.match(
    billingPage,
    /if \(!billing\?\.canOpenPortal\) \{[\s\S]*?return;[\s\S]*?api\.post\('\/billing\/portal'/,
  );
  assert.match(billingPage, /const canStartCheckout = billing\?\.canStartCheckout === true;/);
  assert.match(billingPage, /const canOpenPortal = billing\?\.canOpenPortal === true;/);
  assert.match(billingPage, /\{canOpenPortal \? \([\s\S]*?Manage subscription/);
  assert.match(billingPage, /canStartCheckout=\{canStartCheckout\}/);
  assert.match(billingPage, /canOpenPortal=\{canOpenPortal\}/);
});

test('plan checkout controls render only when the server permits checkout', () => {
  assert.match(
    planSections,
    /\{canStartCheckout \? \([\s\S]*?onPress=\{\(\) => onCheckout\(plan\.plan, 'yearly'\)\}[\s\S]*?onPress=\{\(\) => onCheckout\(plan\.plan, 'monthly'\)\}/,
  );
  assert.match(planSections, /!canStartCheckout && canOpenPortal/);
  assert.match(planSections, /Use the customer portal above for supported subscription changes/);
  assert.match(planSections, /Checkout is not available while Stripe-managed billing exists/);
});

test('billing copy does not promise unverified proration or route existing subscriptions through Checkout', () => {
  const billingCopy = `${planSections}\n${pricingPage}`;

  for (const unsupportedClaim of [
    /pro[- ]?rat(?:e|ed|ion)/i,
    /checkout or the customer portal/i,
    /upgrade from Essentials to Complete at any time/i,
  ]) {
    assert.doesNotMatch(billingCopy, unsupportedClaim);
  }

  assert.match(planSections, /For an existing Stripe-managed subscription, use the customer portal/);
  assert.match(pricingPage, /Existing Stripe-managed subscriptions are changed through the customer portal/);
});
