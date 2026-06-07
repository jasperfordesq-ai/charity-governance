import type { PrismaClient, SubscriptionStatus } from '@prisma/client';
import Stripe from 'stripe';
import { SubscriptionPlan } from '@charitypilot/shared';
import { AppError } from '../utils/errors.js';
import { isConfiguredSecret } from '../utils/env.js';
import { hasSubscriptionAccess } from '../utils/subscription-access.js';

type BillingPrisma = Pick<PrismaClient, 'organisation' | 'stripeWebhookEvent' | 'subscription'>;

const SUBSCRIPTION_PLANS = [SubscriptionPlan.ESSENTIALS, SubscriptionPlan.COMPLETE] as const;

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
  return process.env.FRONTEND_URL ?? 'http://localhost:3000';
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

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002');
}

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
    return (
      isConfiguredSecret(process.env.STRIPE_SECRET_KEY) &&
      isConfiguredSecret(process.env.STRIPE_WEBHOOK_SECRET) &&
      getPriceConfig().every(({ priceId }) => isConfiguredSecret(priceId))
    );
  }

  private getStripe(): Stripe {
    const secretKey = process.env.STRIPE_SECRET_KEY;

    if (!isConfiguredSecret(secretKey)) {
      throw new AppError(503, 'BILLING_NOT_CONFIGURED', 'Stripe secret key is not configured');
    }

    return new Stripe(secretKey);
  }

  private getPriceId(plan: SubscriptionPlan, interval: 'monthly' | 'yearly'): string {
    const priceId = getPriceConfig().find((config) => config.plan === plan && config.interval === interval)?.priceId;

    if (!isConfiguredSecret(priceId)) {
      throw new AppError(
        503,
        'BILLING_NOT_CONFIGURED',
        `Stripe price ID is not configured for ${plan.toLowerCase()} ${interval}`,
      );
    }

    return priceId;
  }

  private getPlanForSubscriptionPrice(sub: Stripe.Subscription): SubscriptionPlan {
    const priceId = getStripeObjectId(sub.items.data[0]?.price);
    const match = getPriceConfig().find((config) => config.priceId === priceId && isConfiguredSecret(config.priceId));

    if (!match) {
      throw new AppError(
        400,
        'STRIPE_WEBHOOK_MISMATCH',
        'Stripe subscription price does not match a configured subscription plan',
      );
    }

    return match.plan;
  }

  private assertStripeIdMatches(actual: string | null, expected: string | null | undefined, message: string): void {
    if (!actual || !expected || actual !== expected) {
      throw new AppError(400, 'STRIPE_WEBHOOK_MISMATCH', message);
    }
  }

  private async handleCheckoutCompleted(
    tx: BillingPrisma,
    stripe: Stripe,
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const organisationId = session.metadata?.organisationId;
    const requestedPlan = session.metadata?.plan;
    const subscriptionId = getStripeObjectId(session.subscription);

    if (!organisationId || !isSubscriptionPlan(requestedPlan) || !subscriptionId) {
      throw new AppError(
        400,
        'STRIPE_WEBHOOK_MISMATCH',
        'Stripe checkout metadata does not match a billable organisation subscription',
      );
    }

    const [organisation, sub] = await Promise.all([
      tx.organisation.findUnique({
        where: { id: organisationId },
        select: { id: true, stripeCustomerId: true },
      }),
      stripe.subscriptions.retrieve(subscriptionId),
    ]);

    if (!organisation) {
      throw new AppError(400, 'STRIPE_WEBHOOK_MISMATCH', 'Stripe checkout organisation does not match local data');
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

    const pricePlan = this.getPlanForSubscriptionPrice(sub);
    if (pricePlan !== requestedPlan) {
      throw new AppError(
        400,
        'STRIPE_WEBHOOK_MISMATCH',
        'Stripe subscription price does not match checkout metadata plan',
      );
    }

    const status = mapStripeSubscriptionStatus(sub.status);

    await tx.subscription.upsert({
      where: { organisationId },
      create: {
        organisationId,
        stripeSubscriptionId: sub.id,
        plan: pricePlan,
        status,
        currentPeriodStart: getDateFromUnixSeconds(sub.current_period_start),
        currentPeriodEnd: getDateFromUnixSeconds(sub.current_period_end),
        trialEndsAt: getDateFromUnixSeconds(sub.trial_end),
      },
      update: {
        stripeSubscriptionId: sub.id,
        plan: pricePlan,
        status,
        currentPeriodStart: getDateFromUnixSeconds(sub.current_period_start),
        currentPeriodEnd: getDateFromUnixSeconds(sub.current_period_end),
        trialEndsAt: getDateFromUnixSeconds(sub.trial_end),
      },
    });
  }

  private verifyExistingSubscription(sub: Stripe.Subscription, existing: {
    organisation: { stripeCustomerId: string | null };
  }): SubscriptionPlan {
    const subscriptionCustomerId = getStripeObjectId(sub.customer);
    this.assertStripeIdMatches(
      subscriptionCustomerId,
      existing.organisation.stripeCustomerId,
      'Stripe subscription customer does not match the organisation',
    );

    return this.getPlanForSubscriptionPrice(sub);
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

    const plan = this.verifyExistingSubscription(sub, existing);

    await tx.subscription.update({
      where: { id: existing.id },
      data: {
        plan,
        status: mapStripeSubscriptionStatus(sub.status),
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

    this.verifyExistingSubscription(sub, existing);

    await tx.subscription.update({
      where: { id: existing.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: getDateFromUnixSeconds(sub.canceled_at) ?? new Date(),
      },
    });
  }

  constructWebhookEvent(rawBody: Buffer, signature: string | undefined): Stripe.Event {
    if (!signature) {
      throw new AppError(400, 'MISSING_STRIPE_SIGNATURE', 'Missing Stripe signature header');
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!isConfiguredSecret(webhookSecret)) {
      throw new AppError(503, 'BILLING_NOT_CONFIGURED', 'Stripe webhook secret is not configured');
    }

    return this.getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      webhookSecret,
    );
  }

  async createCheckoutSession(
    organisationId: string,
    plan: SubscriptionPlan,
    interval: 'monthly' | 'yearly',
  ) {
    const org = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: organisationId },
    });

    const stripe = this.getStripe();
    const priceId = this.getPriceId(plan, interval);

    let customerId = org.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { organisationId },
        name: org.name,
        email: org.contactEmail ?? undefined,
      });
      customerId = customer.id;

      await this.prisma.organisation.update({
        where: { id: organisationId },
        data: { stripeCustomerId: customerId },
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${getFrontendUrl()}/billing?success=true`,
      cancel_url: `${getFrontendUrl()}/billing?cancelled=true`,
      metadata: { organisationId, plan },
    });

    return { url: session.url! };
  }

  async createPortalSession(organisationId: string) {
    const org = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: organisationId },
    });

    if (!org.stripeCustomerId) {
      throw new AppError(400, 'NO_STRIPE_CUSTOMER', 'No billing account found');
    }

    const session = await this.getStripe().billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: `${getFrontendUrl()}/billing`,
    });

    return { url: session.url };
  }

  async getStatus(organisationId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { organisationId },
    });

    if (!subscription) {
      return {
        plan: null,
        status: null,
        trialEndsAt: null,
        currentPeriodEnd: null,
        hasAccess: false,
        billingConfigured: this.isConfigured(),
      };
    }

    const now = new Date();
    const hasAccess = hasSubscriptionAccess(subscription, now);

    return {
      plan: subscription.plan,
      status: subscription.status,
      trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      hasAccess,
      billingConfigured: this.isConfigured(),
    };
  }

  async handleWebhook(event: Stripe.Event) {
    const stripe = this.getStripe();

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
          await this.handleCheckoutCompleted(tx, stripe, event.data.object as Stripe.Checkout.Session);
          break;

        case 'customer.subscription.updated':
          await this.handleSubscriptionUpdated(tx, event.data.object as Stripe.Subscription);
          break;

        case 'customer.subscription.deleted':
          await this.handleSubscriptionDeleted(tx, event.data.object as Stripe.Subscription);
          break;
      }
    });
  }
}
