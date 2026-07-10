import { Prisma, type PrismaClient, type SubscriptionStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { SubscriptionPlan } from '@charitypilot/shared';
import { AppError } from '../utils/errors.js';
import { isConfiguredSecret } from '../utils/env.js';
import { getPrimaryFrontendOrigin } from '../utils/frontend-origin.js';
import { hasSubscriptionAccess } from '../utils/subscription-access.js';

type BillingPrisma = Pick<
  PrismaClient,
  'billingCheckoutAttempt' | 'organisation' | 'stripeWebhookEvent' | 'subscription'
>;

const SUBSCRIPTION_PLANS = [SubscriptionPlan.ESSENTIALS, SubscriptionPlan.COMPLETE] as const;
const BILLING_UNAVAILABLE_MESSAGE = 'Billing is temporarily unavailable. Please contact support to change your plan.';
const CHECKOUT_LEASE_MS = 60 * 60 * 1000;
const MINIMUM_CHECKOUT_CREATION_WINDOW_MS = 31 * 60 * 1000;
const CHECKOUT_CONFLICT_MESSAGE = 'A subscription is already managed by Stripe. Use the customer portal or contact support.';
const STRIPE_TERMINAL_SUBSCRIPTION_STATUSES = new Set(['canceled', 'incomplete_expired']);

type BillingInterval = 'monthly' | 'yearly';

type ConfiguredSubscriptionPrice = {
  plan: SubscriptionPlan;
  interval: BillingInterval;
};

type LocalSubscriptionState = {
  stripeSubscriptionId: string | null;
  status: SubscriptionStatus;
};

type CheckoutAttemptState = {
  id: string;
  organisationId: string;
  requestedPlan: SubscriptionPlan;
  interval: string;
  status: 'PENDING' | 'SESSION_CREATED' | 'COMPLETED';
  stripeCheckoutSessionId: string | null;
  checkoutUrl: string | null;
  expectedPreviousStripeSubscriptionId: string | null;
  expiresAt: Date;
};

function getPriceConfig(): Array<{
  plan: SubscriptionPlan;
  interval: 'monthly' | 'yearly';
  priceId: string | undefined;
}> {
  return [
    { plan: SubscriptionPlan.ESSENTIALS, interval: 'monthly', priceId: process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID },
    { plan: SubscriptionPlan.ESSENTIALS, interval: 'yearly', priceId: process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID },
    { plan: SubscriptionPlan.COMPLETE, interval: 'monthly', priceId: process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID },
    { plan: SubscriptionPlan.COMPLETE, interval: 'yearly', priceId: process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID },
  ];
}

function getFrontendUrl(): string {
  return getPrimaryFrontendOrigin();
}

function getStripeObjectId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

function getDateFromUnixSeconds(value: number | null | undefined): Date | null {
  return typeof value === 'number' ? new Date(value * 1000) : null;
}

function isSubscriptionPlan(value: unknown): value is SubscriptionPlan {
  return typeof value === 'string' && (SUBSCRIPTION_PLANS as readonly string[]).includes(value);
}

function isBillingInterval(value: unknown): value is BillingInterval {
  return value === 'monthly' || value === 'yearly';
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002');
}

function isStripeSignatureVerificationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const stripeError = error as { type?: unknown; name?: unknown };
  return stripeError.type === 'StripeSignatureVerificationError' ||
    stripeError.name === 'StripeSignatureVerificationError';
}

function isStripeMissingResourceError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const stripeError = error as { code?: unknown; statusCode?: unknown; type?: unknown };
  return stripeError.code === 'resource_missing' ||
    (stripeError.statusCode === 404 && stripeError.type === 'StripeInvalidRequestError');
}

function stripeSearchValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

type StripeCustomerOrganisation = {
  id: string;
  stripeCustomerId: string | null;
};

type BillableOrganisation = StripeCustomerOrganisation & {
  name: string;
  contactEmail: string | null;
};

function mapStripeSubscriptionStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'active':
      return 'ACTIVE';
    case 'trialing':
      return 'TRIALING';
    case 'past_due':
      return 'PAST_DUE';
    case 'canceled':
      return 'CANCELLED';
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
    case 'unpaid':
    default:
      return 'EXPIRED';
  }
}

export class BillingService {
  constructor(private prisma: PrismaClient) {}

  isConfigured(): boolean {
    const priceIds = getPriceConfig().map(({ priceId }) => priceId);
    return (
      isConfiguredSecret(process.env.STRIPE_SECRET_KEY) &&
      isConfiguredSecret(process.env.STRIPE_WEBHOOK_SECRET) &&
      isConfiguredSecret(process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID) &&
      priceIds.every((priceId) => isConfiguredSecret(priceId)) &&
      new Set(priceIds).size === priceIds.length
    );
  }

  private getStripe(): Stripe {
    const secretKey = process.env.STRIPE_SECRET_KEY;

    if (!isConfiguredSecret(secretKey)) {
      throw new AppError(503, 'BILLING_NOT_CONFIGURED', BILLING_UNAVAILABLE_MESSAGE);
    }

    return new Stripe(secretKey);
  }

  private assertBillingLifecycleConfigured(): void {
    if (!this.isConfigured()) {
      throw new AppError(503, 'BILLING_NOT_CONFIGURED', BILLING_UNAVAILABLE_MESSAGE);
    }
  }

  private getPriceId(plan: SubscriptionPlan, interval: BillingInterval): string {
    const priceId = getPriceConfig().find((config) => config.plan === plan && config.interval === interval)?.priceId;

    if (!isConfiguredSecret(priceId)) {
      throw new AppError(
        503,
        'BILLING_NOT_CONFIGURED',
        BILLING_UNAVAILABLE_MESSAGE,
      );
    }

    return priceId;
  }

  private getPortalConfigurationId(): string {
    const configurationId = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID;
    if (!isConfiguredSecret(configurationId)) {
      throw new AppError(503, 'BILLING_NOT_CONFIGURED', BILLING_UNAVAILABLE_MESSAGE);
    }
    return configurationId;
  }

  private getConfiguredSubscriptionPrice(sub: Stripe.Subscription): ConfiguredSubscriptionPrice {
    const items = sub.items.data;
    const priceId = getStripeObjectId(items[0]?.price);
    const matches = getPriceConfig().filter(
      (config) => config.priceId === priceId && isConfiguredSecret(config.priceId),
    );

    if (items.length !== 1 || items[0]?.quantity !== 1 || matches.length !== 1) {
      throw new AppError(
        400,
        'STRIPE_WEBHOOK_MISMATCH',
        'Stripe subscription items do not match one configured plan and billing interval',
      );
    }

    return { plan: matches[0]!.plan, interval: matches[0]!.interval };
  }

  private assertStripeIdMatches(actual: string | null, expected: string | null | undefined, message: string): void {
    if (!actual || !expected || actual !== expected) {
      throw new AppError(400, 'STRIPE_WEBHOOK_MISMATCH', message);
    }
  }

  private getCheckoutSubscriptionContext(session: Stripe.Checkout.Session): {
    organisationId: string;
    requestedPlan: SubscriptionPlan;
    interval: BillingInterval;
    checkoutAttemptId: string;
    subscriptionId: string;
  } {
    const organisationId = session.metadata?.organisationId;
    const requestedPlan = session.metadata?.plan;
    const interval = session.metadata?.interval;
    const checkoutAttemptId = session.metadata?.checkoutAttemptId;
    const subscriptionId = getStripeObjectId(session.subscription);

    if (
      !organisationId ||
      !isSubscriptionPlan(requestedPlan) ||
      !isBillingInterval(interval) ||
      !checkoutAttemptId ||
      !subscriptionId
    ) {
      throw new AppError(
        400,
        'STRIPE_WEBHOOK_MISMATCH',
        'Stripe checkout metadata does not match a billable organisation subscription',
      );
    }

    return { organisationId, requestedPlan, interval, checkoutAttemptId, subscriptionId };
  }

  private async resolveCheckoutSubscription(
    stripe: Stripe,
    session: Stripe.Checkout.Session,
  ): Promise<Stripe.Subscription> {
    const { subscriptionId } = this.getCheckoutSubscriptionContext(session);
    return stripe.subscriptions.retrieve(subscriptionId);
  }

  private async findStripeCustomerForOrganisation(stripe: Stripe, organisationId: string): Promise<string | null> {
    if (typeof stripe.customers.search !== 'function') {
      return null;
    }

    const result = await stripe.customers.search({
      query: `metadata['organisationId']:'${stripeSearchValue(organisationId)}'`,
      limit: 10,
    });

    if (result.has_more || result.data.length > 1) {
      throw new AppError(
        409,
        'BILLING_ACCOUNT_REVIEW_REQUIRED',
        'Multiple billing accounts match this workspace. Contact support before changing the subscription.',
      );
    }

    return result.data[0]?.id ?? null;
  }

  private async rememberStripeCustomerId(organisationId: string, customerId: string): Promise<void> {
    await this.prisma.organisation.update({
      where: { id: organisationId },
      data: { stripeCustomerId: customerId },
    });
  }

  private async storedStripeCustomerBelongsToOrganisation(
    stripe: Stripe,
    customerId: string,
    organisationId: string,
  ): Promise<boolean> {
    if (typeof stripe.customers.retrieve !== 'function') {
      return true;
    }

    let customer: Stripe.Customer | Stripe.DeletedCustomer;
    try {
      customer = await stripe.customers.retrieve(customerId);
    } catch (error) {
      if (isStripeMissingResourceError(error)) {
        return false;
      }
      throw error;
    }

    if ('deleted' in customer && customer.deleted) {
      return false;
    }

    return customer.metadata?.organisationId === organisationId;
  }

  private async reconcileStripeCustomerId(
    stripe: Stripe,
    org: StripeCustomerOrganisation,
    localSubscriptionId: string | null = null,
  ): Promise<string | null> {
    let storedCustomerMatches = false;
    if (org.stripeCustomerId) {
      storedCustomerMatches = await this.storedStripeCustomerBelongsToOrganisation(
        stripe,
        org.stripeCustomerId,
        org.id,
      );
    }

    const searchedCustomerId = await this.findStripeCustomerForOrganisation(stripe, org.id);

    if (storedCustomerMatches && searchedCustomerId && searchedCustomerId !== org.stripeCustomerId) {
      throw new AppError(
        409,
        'BILLING_ACCOUNT_REVIEW_REQUIRED',
        'Billing account ownership is ambiguous. Contact support before changing the subscription.',
      );
    }

    let customerId = searchedCustomerId ?? (storedCustomerMatches ? org.stripeCustomerId : null);

    if (localSubscriptionId) {
      let localStripeSubscription: Stripe.Subscription;
      try {
        localStripeSubscription = await stripe.subscriptions.retrieve(localSubscriptionId);
      } catch (error) {
        if (isStripeMissingResourceError(error)) {
          throw new AppError(
            409,
            'BILLING_ACCOUNT_REVIEW_REQUIRED',
            'The saved subscription could not be found in Stripe. Contact support before changing billing.',
          );
        }
        throw error;
      }

      const subscriptionCustomerId = getStripeObjectId(localStripeSubscription.customer);
      if (
        !subscriptionCustomerId ||
        !(await this.storedStripeCustomerBelongsToOrganisation(stripe, subscriptionCustomerId, org.id))
      ) {
        throw new AppError(
          409,
          'BILLING_ACCOUNT_REVIEW_REQUIRED',
          'The saved subscription does not belong to this workspace billing account. Contact support.',
        );
      }

      if (customerId && customerId !== subscriptionCustomerId) {
        throw new AppError(
          409,
          'BILLING_ACCOUNT_REVIEW_REQUIRED',
          'The saved customer and subscription point to different billing accounts. Contact support.',
        );
      }
      customerId = subscriptionCustomerId;
    }

    if (customerId && customerId !== org.stripeCustomerId) {
      await this.rememberStripeCustomerId(org.id, customerId);
    }

    return customerId;
  }

  private async ensureStripeCustomerId(
    stripe: Stripe,
    org: BillableOrganisation,
    localSubscriptionId: string | null,
  ): Promise<string> {
    const reconciledCustomerId = await this.reconcileStripeCustomerId(stripe, org, localSubscriptionId);

    if (reconciledCustomerId) {
      return reconciledCustomerId;
    }

    const customer = await stripe.customers.create(
      {
        metadata: { organisationId: org.id },
        name: org.name,
        email: org.contactEmail ?? undefined,
      },
      { idempotencyKey: `charitypilot-customer-${org.id}` },
    );

    await this.rememberStripeCustomerId(org.id, customer.id);
    return customer.id;
  }

  private async assertNoNonTerminalStripeSubscriptions(
    stripe: Stripe,
    customerId: string,
    expectedLocalSubscriptionId: string | null,
  ): Promise<Set<string>> {
    const result = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100,
    });

    if (result.has_more) {
      throw new AppError(
        409,
        'BILLING_ACCOUNT_REVIEW_REQUIRED',
        'The billing account has too many subscription records for an automatic safety check. Contact support.',
      );
    }

    const nonTerminal = result.data.filter(
      (subscription) => !STRIPE_TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status),
    );
    if (nonTerminal.length > 0) {
      throw new AppError(409, 'STRIPE_SUBSCRIPTION_ALREADY_EXISTS', CHECKOUT_CONFLICT_MESSAGE);
    }

    const terminalIds = new Set(result.data.map((subscription) => subscription.id));
    if (expectedLocalSubscriptionId && !terminalIds.has(expectedLocalSubscriptionId)) {
      throw new AppError(
        409,
        'BILLING_ACCOUNT_REVIEW_REQUIRED',
        'The saved subscription could not be reconciled with Stripe. Contact support before restarting billing.',
      );
    }

    return terminalIds;
  }

  private async reconcileExpiredCheckoutAttempt(
    stripe: Stripe,
    organisationId: string,
  ): Promise<void> {
    const attempt = await this.prisma.billingCheckoutAttempt.findUnique({
      where: { organisationId },
    });

    if (
      !attempt ||
      attempt.status === 'COMPLETED' ||
      attempt.expiresAt > new Date()
    ) {
      return;
    }

    if (!attempt.stripeCheckoutSessionId) {
      if (attempt.status === 'SESSION_CREATED') {
        throw new AppError(
          409,
          'BILLING_ACCOUNT_REVIEW_REQUIRED',
          'The previous Checkout session could not be reconciled. Contact support before restarting billing.',
        );
      }
      return;
    }

    const session = await stripe.checkout.sessions.retrieve(attempt.stripeCheckoutSessionId);
    if (
      session.metadata?.organisationId !== organisationId ||
      session.metadata?.checkoutAttemptId !== attempt.id
    ) {
      throw new AppError(
        409,
        'BILLING_ACCOUNT_REVIEW_REQUIRED',
        'The previous Checkout session does not match this workspace. Contact support before restarting billing.',
      );
    }

    if (session.status === 'complete') {
      throw new AppError(
        409,
        'BILLING_ACCOUNT_REVIEW_REQUIRED',
        'The previous Checkout completed but has not finished reconciling. Wait for billing to update or contact support.',
      );
    }

    if (session.status === 'open') {
      const expired = await stripe.checkout.sessions.expire(session.id);
      if (expired.status !== 'expired') {
        throw new AppError(
          409,
          'BILLING_ACCOUNT_REVIEW_REQUIRED',
          'The previous Checkout session could not be closed safely. Contact support before restarting billing.',
        );
      }
      return;
    }

    if (session.status !== 'expired') {
      throw new AppError(
        409,
        'BILLING_ACCOUNT_REVIEW_REQUIRED',
        'The previous Checkout session has an unknown state. Contact support before restarting billing.',
      );
    }
  }

  private async assertCheckoutSubscriptionIsUnique(
    stripe: Stripe,
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const customerId = getStripeObjectId(subscription.customer);
    if (!customerId) {
      throw new AppError(400, 'STRIPE_WEBHOOK_MISMATCH', 'Stripe subscription customer is unavailable');
    }

    const result = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100,
    });

    if (result.has_more) {
      throw new AppError(
        409,
        'BILLING_ACCOUNT_REVIEW_REQUIRED',
        'The billing account has too many subscription records for an automatic safety check. Contact support.',
      );
    }

    if (!result.data.some((candidate) => candidate.id === subscription.id)) {
      throw new AppError(
        400,
        'STRIPE_WEBHOOK_MISMATCH',
        'Stripe checkout subscription was not found on the billing account',
      );
    }

    const otherNonTerminalSubscription = result.data.find(
      (candidate) =>
        candidate.id !== subscription.id &&
        !STRIPE_TERMINAL_SUBSCRIPTION_STATUSES.has(candidate.status),
    );
    if (otherNonTerminalSubscription) {
      throw new AppError(409, 'STRIPE_SUBSCRIPTION_ALREADY_EXISTS', CHECKOUT_CONFLICT_MESSAGE);
    }
  }

  private assertLocalCheckoutAllowed(
    subscription: LocalSubscriptionState | null,
    providerConfirmedTerminalIds: Set<string>,
  ): void {
    if (!subscription) return;

    if (!subscription.stripeSubscriptionId) {
      if (subscription.status === 'TRIALING' || subscription.status === 'CANCELLED' || subscription.status === 'EXPIRED') {
        return;
      }
      throw new AppError(409, 'BILLING_ACCOUNT_REVIEW_REQUIRED', CHECKOUT_CONFLICT_MESSAGE);
    }

    if (!providerConfirmedTerminalIds.has(subscription.stripeSubscriptionId)) {
      throw new AppError(409, 'STRIPE_SUBSCRIPTION_ALREADY_EXISTS', CHECKOUT_CONFLICT_MESSAGE);
    }
  }

  private async claimCheckoutAttempt(
    organisationId: string,
    plan: SubscriptionPlan,
    interval: BillingInterval,
    providerConfirmedTerminalIds: Set<string>,
  ): Promise<CheckoutAttemptState> {
    for (let attemptNumber = 0; attemptNumber < 3; attemptNumber += 1) {
      try {
        return await this.prisma.$transaction(async (transaction) => {
          const tx = transaction as BillingPrisma;
          const [subscription, existingAttempt] = await Promise.all([
            tx.subscription.findUnique({
              where: { organisationId },
              select: { stripeSubscriptionId: true, status: true },
            }),
            tx.billingCheckoutAttempt.findUnique({ where: { organisationId } }),
          ]);

          this.assertLocalCheckoutAllowed(subscription, providerConfirmedTerminalIds);

          const now = new Date();
          if (
            existingAttempt &&
            existingAttempt.status !== 'COMPLETED' &&
            existingAttempt.expiresAt > now
          ) {
            if (existingAttempt.requestedPlan !== plan || existingAttempt.interval !== interval) {
              throw new AppError(
                409,
                'CHECKOUT_ALREADY_PENDING',
                'Another Checkout is already being prepared for this workspace. Finish or retry that request first.',
              );
            }
            return existingAttempt as CheckoutAttemptState;
          }

          if (existingAttempt) {
            await tx.billingCheckoutAttempt.delete({ where: { id: existingAttempt.id } });
          }

          const expiresAt = new Date(now.getTime() + CHECKOUT_LEASE_MS);
          return tx.billingCheckoutAttempt.create({
            data: {
              id: randomUUID(),
              organisationId,
              requestedPlan: plan,
              interval,
              status: 'PENDING',
              expectedPreviousStripeSubscriptionId: subscription?.stripeSubscriptionId ?? null,
              expiresAt,
            },
          }) as Promise<CheckoutAttemptState>;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
        if ((code === 'P2002' || code === 'P2034') && attemptNumber < 2) {
          continue;
        }
        throw error;
      }
    }

    throw new AppError(
      409,
      'CHECKOUT_ALREADY_PENDING',
      'Checkout state changed concurrently. Refresh billing before trying again.',
    );
  }

  private async hasProcessedWebhookEvent(eventId: string): Promise<boolean> {
    const existing = await this.prisma.stripeWebhookEvent.findUnique({
      where: { id: eventId },
      select: { id: true },
    });
    return Boolean(existing);
  }

  private async handleCheckoutCompleted(
    tx: BillingPrisma,
    session: Stripe.Checkout.Session,
    sub: Stripe.Subscription,
  ): Promise<void> {
    const {
      organisationId,
      requestedPlan,
      interval,
      checkoutAttemptId,
      subscriptionId,
    } = this.getCheckoutSubscriptionContext(session);

    const [organisation, checkoutAttempt, existingSubscription] = await Promise.all([
      tx.organisation.findUnique({
        where: { id: organisationId },
        select: { id: true, stripeCustomerId: true },
      }),
      tx.billingCheckoutAttempt.findUnique({ where: { organisationId } }),
      tx.subscription.findUnique({
        where: { organisationId },
        select: { stripeSubscriptionId: true, status: true },
      }),
    ]);

    if (!organisation) {
      throw new AppError(400, 'STRIPE_WEBHOOK_MISMATCH', 'Stripe checkout organisation does not match local data');
    }

    if (
      !checkoutAttempt ||
      checkoutAttempt.id !== checkoutAttemptId ||
      checkoutAttempt.requestedPlan !== requestedPlan ||
      checkoutAttempt.interval !== interval
    ) {
      throw new AppError(400, 'STRIPE_WEBHOOK_MISMATCH', 'Stripe checkout attempt is unknown or superseded');
    }

    if (
      checkoutAttempt.stripeCheckoutSessionId &&
      checkoutAttempt.stripeCheckoutSessionId !== session.id
    ) {
      throw new AppError(400, 'STRIPE_WEBHOOK_MISMATCH', 'Stripe checkout session does not match the active attempt');
    }

    if (sub.id !== subscriptionId) {
      throw new AppError(400, 'STRIPE_WEBHOOK_MISMATCH', 'Stripe checkout subscription does not match the session');
    }

    if (
      checkoutAttempt.status === 'COMPLETED' &&
      existingSubscription?.stripeSubscriptionId === sub.id
    ) {
      return;
    }

    const existingSubscriptionId = existingSubscription?.stripeSubscriptionId ?? null;
    if (existingSubscriptionId !== checkoutAttempt.expectedPreviousStripeSubscriptionId) {
      throw new AppError(
        409,
        'STRIPE_SUBSCRIPTION_ALREADY_EXISTS',
        'A different subscription became active while Checkout was pending',
      );
    }

    const sessionCustomerId = getStripeObjectId(session.customer);
    const subscriptionCustomerId = getStripeObjectId(sub.customer);
    this.assertStripeIdMatches(
      sessionCustomerId,
      organisation.stripeCustomerId,
      'Stripe checkout customer does not match the organisation',
    );
    this.assertStripeIdMatches(
      subscriptionCustomerId,
      organisation.stripeCustomerId,
      'Stripe subscription customer does not match the organisation',
    );

    const configuredPrice = this.getConfiguredSubscriptionPrice(sub);
    if (configuredPrice.plan !== requestedPlan || configuredPrice.interval !== interval) {
      throw new AppError(
        400,
        'STRIPE_WEBHOOK_MISMATCH',
        'Stripe subscription price does not match checkout metadata plan and interval',
      );
    }

    const status = mapStripeSubscriptionStatus(sub.status);

    await tx.subscription.upsert({
      where: { organisationId },
      create: {
        organisationId,
        stripeSubscriptionId: sub.id,
        stripeStatus: sub.status,
        plan: configuredPrice.plan,
        status,
        billingInterval: configuredPrice.interval,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        currentPeriodStart: getDateFromUnixSeconds(sub.current_period_start),
        currentPeriodEnd: getDateFromUnixSeconds(sub.current_period_end),
        trialEndsAt: getDateFromUnixSeconds(sub.trial_end),
        cancelledAt: getDateFromUnixSeconds(sub.canceled_at),
      },
      update: {
        stripeSubscriptionId: sub.id,
        stripeStatus: sub.status,
        plan: configuredPrice.plan,
        status,
        billingInterval: configuredPrice.interval,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        currentPeriodStart: getDateFromUnixSeconds(sub.current_period_start),
        currentPeriodEnd: getDateFromUnixSeconds(sub.current_period_end),
        trialEndsAt: getDateFromUnixSeconds(sub.trial_end),
        cancelledAt: getDateFromUnixSeconds(sub.canceled_at),
      },
    });

    await tx.billingCheckoutAttempt.update({
      where: { id: checkoutAttempt.id },
      data: {
        status: 'COMPLETED',
        stripeCheckoutSessionId: session.id,
        checkoutUrl: null,
      },
    });
  }

  private verifyExistingSubscription(sub: Stripe.Subscription, existing: {
    organisation: { stripeCustomerId: string | null };
  }): ConfiguredSubscriptionPrice {
    const subscriptionCustomerId = getStripeObjectId(sub.customer);
    this.assertStripeIdMatches(
      subscriptionCustomerId,
      existing.organisation.stripeCustomerId,
      'Stripe subscription customer does not match the organisation',
    );

    return this.getConfiguredSubscriptionPrice(sub);
  }

  private async handleSubscriptionUpdated(tx: BillingPrisma, sub: Stripe.Subscription): Promise<void> {
    const existing = await tx.subscription.findUnique({
      where: { stripeSubscriptionId: sub.id },
      include: {
        organisation: {
          select: { stripeCustomerId: true },
        },
      },
    });

    if (!existing) return;

    const configuredPrice = this.verifyExistingSubscription(sub, existing);

    await tx.subscription.update({
      where: { id: existing.id },
      data: {
        plan: configuredPrice.plan,
        status: mapStripeSubscriptionStatus(sub.status),
        stripeStatus: sub.status,
        billingInterval: configuredPrice.interval,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        currentPeriodStart: getDateFromUnixSeconds(sub.current_period_start),
        currentPeriodEnd: getDateFromUnixSeconds(sub.current_period_end),
        trialEndsAt: getDateFromUnixSeconds(sub.trial_end),
        cancelledAt: getDateFromUnixSeconds(sub.canceled_at),
      },
    });
  }

  private async handleSubscriptionDeleted(tx: BillingPrisma, sub: Stripe.Subscription): Promise<void> {
    const existing = await tx.subscription.findUnique({
      where: { stripeSubscriptionId: sub.id },
      include: {
        organisation: {
          select: { stripeCustomerId: true },
        },
      },
    });

    if (!existing) return;

    const configuredPrice = this.verifyExistingSubscription(sub, existing);

    await tx.subscription.update({
      where: { id: existing.id },
      data: {
        status: 'CANCELLED',
        stripeStatus: sub.status,
        billingInterval: configuredPrice.interval,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        cancelledAt: getDateFromUnixSeconds(sub.canceled_at) ?? new Date(),
        currentPeriodStart: getDateFromUnixSeconds(sub.current_period_start),
        currentPeriodEnd: getDateFromUnixSeconds(sub.current_period_end),
      },
    });
  }

  constructWebhookEvent(rawBody: Buffer, signature: string | undefined): Stripe.Event {
    if (!signature) {
      throw new AppError(400, 'MISSING_STRIPE_SIGNATURE', 'Missing Stripe signature header');
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!isConfiguredSecret(webhookSecret)) {
      throw new AppError(503, 'BILLING_NOT_CONFIGURED', BILLING_UNAVAILABLE_MESSAGE);
    }

    try {
      return this.getStripe().webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch (error) {
      if (isStripeSignatureVerificationError(error)) {
        throw new AppError(400, 'INVALID_STRIPE_SIGNATURE', 'Invalid Stripe signature');
      }

      throw error;
    }
  }

  async createCheckoutSession(
    organisationId: string,
    plan: SubscriptionPlan,
    interval: BillingInterval,
  ) {
    this.assertBillingLifecycleConfigured();
    const org = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: organisationId },
      include: {
        subscription: {
          select: { stripeSubscriptionId: true, status: true },
        },
      },
    });

    const stripe = this.getStripe();
    const priceId = this.getPriceId(plan, interval);

    const customerId = await this.ensureStripeCustomerId(
      stripe,
      org,
      org.subscription?.stripeSubscriptionId ?? null,
    );
    await this.reconcileExpiredCheckoutAttempt(stripe, organisationId);
    const providerConfirmedTerminalIds = await this.assertNoNonTerminalStripeSubscriptions(
      stripe,
      customerId,
      org.subscription?.stripeSubscriptionId ?? null,
    );
    const attempt = await this.claimCheckoutAttempt(
      organisationId,
      plan,
      interval,
      providerConfirmedTerminalIds,
    );

    if (attempt.status === 'SESSION_CREATED' && attempt.checkoutUrl) {
      return { url: attempt.checkoutUrl };
    }

    if (attempt.expiresAt.getTime() - Date.now() < MINIMUM_CHECKOUT_CREATION_WINDOW_MS) {
      throw new AppError(
        409,
        'CHECKOUT_ALREADY_PENDING',
        'The previous Checkout request is still settling. Wait for it to expire before trying again.',
      );
    }

    const session = await stripe.checkout.sessions.create(
      {
        customer: customerId,
        client_reference_id: organisationId,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${getFrontendUrl()}/billing?success=true`,
        cancel_url: `${getFrontendUrl()}/billing?cancelled=true`,
        expires_at: Math.floor(attempt.expiresAt.getTime() / 1000),
        metadata: {
          organisationId,
          plan,
          interval,
          checkoutAttemptId: attempt.id,
        },
        subscription_data: {
          metadata: { organisationId, checkoutAttemptId: attempt.id },
        },
      },
      { idempotencyKey: `charitypilot-checkout-${attempt.id}` },
    );

    if (!session.id || !session.url) {
      throw new AppError(502, 'STRIPE_CHECKOUT_FAILED', 'Stripe did not return a usable Checkout session');
    }

    const finalized = await this.prisma.billingCheckoutAttempt.updateMany({
      where: { id: attempt.id, status: 'PENDING' },
      data: {
        status: 'SESSION_CREATED',
        stripeCheckoutSessionId: session.id,
        checkoutUrl: session.url,
      },
    });

    if (finalized.count !== 1) {
      const current = await this.prisma.billingCheckoutAttempt.findUnique({ where: { id: attempt.id } });
      if (
        current?.status === 'SESSION_CREATED' &&
        current.stripeCheckoutSessionId === session.id &&
        current.checkoutUrl
      ) {
        return { url: current.checkoutUrl };
      }
      if (
        current?.status === 'COMPLETED' &&
        current.stripeCheckoutSessionId === session.id
      ) {
        return { url: session.url };
      }

      throw new AppError(
        409,
        'CHECKOUT_ALREADY_PENDING',
        'Checkout state changed while Stripe was preparing the session. Refresh billing before trying again.',
      );
    }

    return { url: session.url };
  }

  async createPortalSession(organisationId: string) {
    this.assertBillingLifecycleConfigured();
    const org = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: organisationId },
      include: {
        subscription: {
          select: { stripeSubscriptionId: true },
        },
      },
    });

    const stripe = this.getStripe();
    const customerId = await this.reconcileStripeCustomerId(
      stripe,
      org,
      org.subscription?.stripeSubscriptionId ?? null,
    );

    if (!customerId) {
      throw new AppError(400, 'NO_STRIPE_CUSTOMER', 'No billing account found');
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      configuration: this.getPortalConfigurationId(),
      return_url: `${getFrontendUrl()}/billing`,
    });

    return { url: session.url };
  }

  async getStatus(organisationId: string) {
    const [subscription, organisation] = await Promise.all([
      this.prisma.subscription.findUnique({ where: { organisationId } }),
      this.prisma.organisation.findUnique({
        where: { id: organisationId },
        select: { stripeCustomerId: true },
      }),
    ]);

    const billingConfigured = this.isConfigured();

    if (!subscription) {
      return {
        plan: null,
        status: null,
        stripeStatus: null,
        billingInterval: null,
        cancelAtPeriodEnd: false,
        trialEndsAt: null,
        currentPeriodEnd: null,
        hasAccess: false,
        billingConfigured,
        canStartCheckout: billingConfigured,
        canOpenPortal: billingConfigured && Boolean(organisation?.stripeCustomerId),
      };
    }

    const now = new Date();
    const hasAccess = hasSubscriptionAccess(subscription, now);
    const canStartCheckout = billingConfigured && (
      (!subscription.stripeSubscriptionId &&
        (subscription.status === 'TRIALING' ||
          subscription.status === 'CANCELLED' ||
          subscription.status === 'EXPIRED')) ||
      (Boolean(subscription.stripeSubscriptionId) &&
        typeof subscription.stripeStatus === 'string' &&
        STRIPE_TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.stripeStatus))
    );
    const canOpenPortal = billingConfigured && Boolean(
      organisation?.stripeCustomerId || subscription.stripeSubscriptionId,
    );

    return {
      plan: subscription.plan,
      status: subscription.status,
      stripeStatus: subscription.stripeStatus,
      billingInterval: subscription.billingInterval,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      hasAccess,
      billingConfigured,
      canStartCheckout,
      canOpenPortal,
    };
  }

  async handleWebhook(event: Stripe.Event) {
    if (await this.hasProcessedWebhookEvent(event.id)) {
      return;
    }

    const stripe = this.getStripe();
    const checkoutSubscription = event.type === 'checkout.session.completed'
      ? await this.resolveCheckoutSubscription(stripe, event.data.object as Stripe.Checkout.Session)
      : null;
    const authoritativeSubscription = (
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    )
      ? await stripe.subscriptions.retrieve((event.data.object as Stripe.Subscription).id)
      : null;

    if (checkoutSubscription) {
      await this.assertCheckoutSubscriptionIsUnique(stripe, checkoutSubscription);
    }

    await this.prisma.$transaction(async (transaction) => {
      const tx = transaction as BillingPrisma;
      try {
        await tx.stripeWebhookEvent.create({
          data: {
            id: event.id,
            type: event.type,
          },
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) return;
        throw error;
      }

      switch (event.type) {
        case 'checkout.session.completed':
          if (!checkoutSubscription) {
            throw new AppError(400, 'STRIPE_WEBHOOK_MISMATCH', 'Stripe checkout subscription is unavailable');
          }
          await this.handleCheckoutCompleted(tx, event.data.object as Stripe.Checkout.Session, checkoutSubscription);
          break;

        case 'customer.subscription.updated':
          if (!authoritativeSubscription) {
            throw new AppError(400, 'STRIPE_WEBHOOK_MISMATCH', 'Stripe subscription state is unavailable');
          }
          await this.handleSubscriptionUpdated(tx, authoritativeSubscription);
          break;

        case 'customer.subscription.deleted':
          if (!authoritativeSubscription) {
            throw new AppError(400, 'STRIPE_WEBHOOK_MISMATCH', 'Stripe subscription state is unavailable');
          }
          await this.handleSubscriptionDeleted(tx, authoritativeSubscription);
          break;
      }
    });
  }
}
