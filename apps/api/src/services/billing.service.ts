import type { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import type { SubscriptionPlan } from '@charitypilot/shared';
import { AppError } from '../utils/errors.js';
import { isConfiguredSecret } from '../utils/env.js';

const PRICE_MAP: Record<string, string | undefined> = {
  ESSENTIALS_monthly: process.env.STRIPE_ESSENTIALS_MONTHLY_PRICE_ID,
  ESSENTIALS_yearly: process.env.STRIPE_ESSENTIALS_YEARLY_PRICE_ID,
  COMPLETE_monthly: process.env.STRIPE_COMPLETE_MONTHLY_PRICE_ID,
  COMPLETE_yearly: process.env.STRIPE_COMPLETE_YEARLY_PRICE_ID,
};

function getFrontendUrl(): string {
  return process.env.FRONTEND_URL ?? 'http://localhost:3000';
}

export class BillingService {
  constructor(private prisma: PrismaClient) {}

  isConfigured(): boolean {
    return (
      isConfiguredSecret(process.env.STRIPE_SECRET_KEY) &&
      isConfiguredSecret(process.env.STRIPE_WEBHOOK_SECRET) &&
      Object.values(PRICE_MAP).every(isConfiguredSecret)
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
    const priceId = PRICE_MAP[`${plan}_${interval}`];

    if (!isConfiguredSecret(priceId)) {
      throw new AppError(
        503,
        'BILLING_NOT_CONFIGURED',
        `Stripe price ID is not configured for ${plan.toLowerCase()} ${interval}`,
      );
    }

    return priceId;
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
    let hasAccess = false;

    if (subscription.status === 'ACTIVE' || subscription.status === 'PAST_DUE') {
      hasAccess = true;
    } else if (subscription.status === 'TRIALING') {
      hasAccess = !subscription.trialEndsAt || subscription.trialEndsAt > now;
    }

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

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const organisationId = session.metadata?.organisationId;
        const plan = session.metadata?.plan as SubscriptionPlan;

        if (organisationId && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription as string);

          await this.prisma.subscription.upsert({
            where: { organisationId },
            create: {
              organisationId,
              stripeSubscriptionId: sub.id,
              plan,
              status: 'ACTIVE',
              currentPeriodStart: new Date(sub.current_period_start * 1000),
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
            },
            update: {
              stripeSubscriptionId: sub.id,
              plan,
              status: 'ACTIVE',
              currentPeriodStart: new Date(sub.current_period_start * 1000),
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
              trialEndsAt: null,
            },
          });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const existing = await this.prisma.subscription.findUnique({
          where: { stripeSubscriptionId: sub.id },
        });

        if (existing) {
          let status: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED' = 'ACTIVE';
          if (sub.status === 'past_due') status = 'PAST_DUE';
          if (sub.status === 'canceled') status = 'CANCELLED';
          if (sub.status === 'unpaid') status = 'EXPIRED';

          await this.prisma.subscription.update({
            where: { id: existing.id },
            data: {
              status,
              currentPeriodStart: new Date(sub.current_period_start * 1000),
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
              cancelledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
            },
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await this.prisma.subscription.updateMany({
          where: { stripeSubscriptionId: sub.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
          },
        });
        break;
      }
    }
  }
}
