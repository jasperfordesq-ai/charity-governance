# Stripe & Resend Production Setup

Step-by-step setup for the two providers that need the most configuration. Pair
this with `docs/supabase-production-setup.md` (storage) and `docs/LAUNCH-GUIDE.md`
(the overall path). After filling the values below into `.env.production`, verify
them with:

```bash
npm run check:production:providers -- --production-env-file=.env.production
```

That checker confirms the four Stripe prices exist as active live recurring
prices, that an enabled live webhook targets your API, and that the Resend
sender domain is verified — so you get a clear pass/fail instead of guessing.

---

## Stripe (subscription billing)

You are creating **live-mode** products. Do all of this with the Stripe
dashboard toggled to **live** (not test).

### 1. Business verification
Activate your Stripe account (business details, bank account). Live keys and
live charges do not work until the account is activated. This can take a little
time, so start it early.

### 2. Create two products with two prices each
CharityPilot has two plans, each billable monthly or yearly — **four prices total**.

1. Product **"CharityPilot Essentials"** → add two recurring prices:
   - Monthly → copy its price ID into `STRIPE_ESSENTIALS_MONTHLY_PRICE_ID`
   - Yearly → `STRIPE_ESSENTIALS_YEARLY_PRICE_ID`
2. Product **"CharityPilot Complete"** → add two recurring prices:
   - Monthly → `STRIPE_COMPLETE_MONTHLY_PRICE_ID`
   - Yearly → `STRIPE_COMPLETE_YEARLY_PRICE_ID`

A price ID looks like `price_1AbC...`. Each must be a **recurring** price (not
one-off) and **active**.

### 3. Copy the API keys
From the live API keys page:
- Secret key (`sk_live_…`) → `STRIPE_SECRET_KEY`
- Publishable key (`pk_live_…`) → `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`

### 4. Create the webhook endpoint
Add a webhook endpoint pointing at your deployed API:

```
https://api.charitypilot.ie/api/v1/billing/webhooks
```

Subscribe it to at least these events:
- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Then copy the endpoint's **signing secret** (`whsec_…`) into
`STRIPE_WEBHOOK_SECRET`. The API verifies every webhook against this secret, so
it must match exactly.

### Stripe values in `.env.production`
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_ESSENTIALS_MONTHLY_PRICE_ID=price_...
STRIPE_ESSENTIALS_YEARLY_PRICE_ID=price_...
STRIPE_COMPLETE_MONTHLY_PRICE_ID=price_...
STRIPE_COMPLETE_YEARLY_PRICE_ID=price_...
```

---

## Resend (transactional email)

The app sends verification, password-reset, invite, and reminder emails. These
must come from a domain you control and have verified.

### 1. Verify your sending domain
In Resend, add and verify `charitypilot.ie` (or your chosen domain) by creating
the DNS records Resend gives you (SPF/DKIM). Verification fails until those DNS
records propagate, so do this early.

### 2. Create an API key
Create a production API key (`re_…`).

### 3. Set the sender
`EMAIL_FROM` must be an address **on the verified domain** — the production
config requires an approved CharityPilot sender. `noreply@charitypilot.ie` is the
default.

### Resend values in `.env.production`
```
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@charitypilot.ie
```

---

## After setup
Run the providers checker (above). When it passes, billing checkout and all
transactional email will work against live Stripe and Resend. Record the redacted
output in `docs/production-launch-checklist.md` (section 7).
