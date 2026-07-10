# Stripe and Resend Production Setup

This guide covers the two provider accounts with the most product-specific
configuration. Pair it with `docs/supabase-production-setup.md` and
`docs/LAUNCH-GUIDE.md`. Keep real keys and provider evidence outside Git.

After filling the approved secret source or an untracked `.env.production`, run
the redacted live checker from a trusted shell:

```bash
npm run check:production:providers -- --production-env-file=.env.production
```

That checker verifies provider configuration. It does not prove historical
Stripe state is clean, that no legacy Checkout URL remains open, that Resend
accepted a real message, or that the deployed end-to-end billing journeys work.
Those are separate launch-evidence steps below and in
`docs/production-launch-checklist.md`.

---

## Stripe subscription billing

Perform every step with the Stripe dashboard in **live mode**. CharityPilot
uses server-created Checkout for a first subscription or a provider-confirmed
terminal restart. Existing Stripe-managed subscriptions are changed and
cancelled through one explicitly pinned Billing Portal configuration.

### 1. Complete Stripe business activation

Complete business, bank, tax, support, and statement-descriptor configuration
with the accountable business/finance owner. Do not enable real charges until
the account and customer-facing details have been approved.

### 2. Create the exact two-product/four-price catalogue

Create exactly these approved recurring prices:

| Product | Cadence | Amount | Environment variable |
| --- | --- | --- | --- |
| CharityPilot Essentials | monthly, interval count 1 | EUR 19.00 | `STRIPE_ESSENTIALS_MONTHLY_PRICE_ID` |
| CharityPilot Essentials | yearly, interval count 1 | EUR 190.00 | `STRIPE_ESSENTIALS_YEARLY_PRICE_ID` |
| CharityPilot Complete | monthly, interval count 1 | EUR 39.00 | `STRIPE_COMPLETE_MONTHLY_PRICE_ID` |
| CharityPilot Complete | yearly, interval count 1 | EUR 390.00 | `STRIPE_COMPLETE_YEARLY_PRICE_ID` |

All four prices must be active, live-mode, recurring EUR prices with distinct
`price_...` IDs. The two Essentials prices must share one Stripe product; the
two Complete prices must share a different product. Do not add another price to
the portal allow-list without a matching code, test, product-copy, and launch
review.

At runtime CharityPilot accepts only one subscription item at quantity one and
maps its exact configured price ID to both plan and billing interval. A
different price, additional item, or quantity is rejected by webhook
reconciliation rather than silently changing entitlement.

### 3. Create and pin a safe Billing Portal configuration

Create a dedicated live Billing Portal configuration for CharityPilot. It must
be active and have this policy:

- subscription updates enabled;
- price changes allowed;
- quantity changes not allowed;
- the product/price allow-list contains exactly the two products and four
  prices above;
- proration behavior is chosen explicitly and approved by the business/finance
  owner;
- subscription cancellation is enabled in **at period end** mode;
- cancellation proration behavior is chosen explicitly.

Record its `bpc_...` ID as `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`. The API
passes this ID on every portal-session request and does not rely on Stripe's
default configuration. Product copy intentionally does not promise a specific
proration outcome; the chosen live policy and customer-facing Stripe copy must
agree.

### 4. Create the webhook endpoint

Create an enabled live endpoint at:

```text
https://api.charitypilot.ie/api/v1/billing/webhooks
```

Subscribe it to at least:

- `checkout.session.completed`;
- `customer.subscription.updated`;
- `customer.subscription.deleted`.

Store the endpoint signing secret (`whsec_...`) as
`STRIPE_WEBHOOK_SECRET`. CharityPilot verifies the raw request signature and
then re-retrieves handled subscriptions from Stripe; the mutable event payload
is not the subscription authority.

### 5. Store the live API values

Store values in the approved production secret manager. If an untracked
`.env.production` is materialised for a trusted command, use this shape:

```dotenv
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_...
STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_...
STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_...
STRIPE_COMPLETE_YEARLY_PRICE_ID=price_...
STRIPE_BILLING_PORTAL_CONFIGURATION_ID=bpc_...
```

Never paste these values into an issue, command transcript, screenshot,
evidence JSON, or committed file.

### 6. Reconcile legacy Checkout and subscription state before rollout

The attempt-bound Checkout guard cannot invalidate a subscription-mode Checkout
URL created by an older release. Before deploying/enabling this billing change,
the Stripe billing owner must perform and record this preflight:

1. Inventory every CharityPilot customer by `metadata.organisationId`; resolve
   missing, duplicate, or conflicting mappings before launch.
2. Inventory every subscription for each customer, including terminal states.
   Confirm each customer has at most one non-terminal subscription. Escalate any
   duplicate charge/cancellation/refund decision to the authorised billing
   owner; do not let an agent choose automatically.
3. Inventory subscription-mode Checkout sessions created by earlier
   CharityPilot releases. Explicitly expire every session that is still open.
4. Reconcile every completed legacy session to its customer, subscription, and
   local organisation before rollout. Do not deploy while a completed session
   is waiting for uncertain webhook reconciliation.
5. Record the operator, date, account mode, redacted counts, exceptions,
   resolutions, and evidence location outside Git.
6. Deploy the database migration before the API that uses
   `BillingCheckoutAttempt`, then repeat the no-duplicate check after the
   production smoke journey.

### 7. Verify live Stripe configuration and behavior

Run:

```bash
npm run check:production:providers -- --production-env-file=.env.production
```

The Stripe portion must prove the exact active/live price amounts, cadences,
currency, product grouping, distinct IDs, pinned active/live portal policy,
exact portal allow-list, price-only changes, at-period-end cancellation, live
webhook URL, and required events.

Then exercise and record, against the promoted release and approved provider
mode:

- first purchase with rapid duplicate clicks producing one subscription;
- supported portal plan/interval change;
- scheduled cancellation and the later terminal webhook;
- restart only after provider-confirmed `canceled` or `incomplete_expired`;
- webhook retry/out-of-order behavior;
- provider/customer ambiguity failing closed without a second charge.

Provider output and browser evidence must be redacted and stored outside Git.

---

## Resend transactional email

The app sends verification, password-reset, invitation, and deadline-reminder
emails. These must use a domain controlled by the production operator.

### 1. Verify the sending domain

Add `charitypilot.ie` (or the approved production sender domain) in Resend and
publish the provider's SPF/DKIM records. Wait for Resend to report the domain as
verified.

### 2. Create and store an API key

Create a production API key (`re_...`) and store it only in the approved API
secret source as `RESEND_API_KEY`.

### 3. Configure the sender

`EMAIL_FROM` must be an approved address on the verified domain. The production
default is `noreply@charitypilot.ie`:

```dotenv
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@charitypilot.ie
```

### 4. Prove provider acceptance

The provider checker verifies the domain state, but launch evidence must also
include a real accepted message ID or equivalent provider reference and prove
that verification/reset links use `https://app.charitypilot.ie`. A mocked
`{ data: { id }, error: null }` response is repository test evidence, not a live
Resend acceptance.

---

## Evidence handoff

Record redacted command output and external evidence references in section 7 of
`docs/production-launch-checklist.md`. A passing provider checker is necessary
but does not close billing/email until legacy Stripe state, deployed flows,
actual Resend acceptance, webhook behavior, and accountable-owner review are
also evidenced.
