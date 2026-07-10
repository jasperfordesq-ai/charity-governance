CREATE TYPE "BillingCheckoutAttemptStatus" AS ENUM ('PENDING', 'SESSION_CREATED', 'COMPLETED');

ALTER TABLE "Subscription"
    ADD COLUMN "stripeStatus" TEXT,
    ADD COLUMN "billingInterval" TEXT,
    ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT "Subscription_billingInterval_check"
        CHECK ("billingInterval" IS NULL OR "billingInterval" IN ('monthly', 'yearly'));

CREATE TABLE "BillingCheckoutAttempt" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "requestedPlan" "SubscriptionPlan" NOT NULL,
    "interval" TEXT NOT NULL,
    "status" "BillingCheckoutAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "stripeCheckoutSessionId" TEXT,
    "checkoutUrl" TEXT,
    "expectedPreviousStripeSubscriptionId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingCheckoutAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingCheckoutAttempt_interval_check" CHECK ("interval" IN ('monthly', 'yearly')),
    CONSTRAINT "BillingCheckoutAttempt_state_check" CHECK (
        ("status" = 'PENDING' AND "stripeCheckoutSessionId" IS NULL AND "checkoutUrl" IS NULL)
        OR ("status" = 'SESSION_CREATED' AND "stripeCheckoutSessionId" IS NOT NULL AND "checkoutUrl" IS NOT NULL)
        OR ("status" = 'COMPLETED' AND "stripeCheckoutSessionId" IS NOT NULL AND "checkoutUrl" IS NULL)
    )
);

CREATE UNIQUE INDEX "BillingCheckoutAttempt_organisationId_key"
    ON "BillingCheckoutAttempt"("organisationId");

CREATE UNIQUE INDEX "BillingCheckoutAttempt_stripeCheckoutSessionId_key"
    ON "BillingCheckoutAttempt"("stripeCheckoutSessionId");

CREATE INDEX "BillingCheckoutAttempt_expiresAt_idx"
    ON "BillingCheckoutAttempt"("expiresAt");

ALTER TABLE "BillingCheckoutAttempt"
    ADD CONSTRAINT "BillingCheckoutAttempt_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
