const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_PAST_DUE_GRACE_DAYS = 7;
const MAX_PAST_DUE_GRACE_DAYS = 30;

type SubscriptionAccessInput = {
  status: string;
  trialEndsAt?: Date | null;
  currentPeriodEnd?: Date | null;
} | null | undefined;

export function pastDueGraceDays(): number {
  const configured = Number(process.env.PAST_DUE_GRACE_DAYS ?? DEFAULT_PAST_DUE_GRACE_DAYS);
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_PAST_DUE_GRACE_DAYS;
  return Math.min(configured, MAX_PAST_DUE_GRACE_DAYS);
}

export function pastDueGraceCutoff(now = new Date()): Date {
  return new Date(now.getTime() - pastDueGraceDays() * MS_PER_DAY);
}

export function hasSubscriptionAccess(subscription: SubscriptionAccessInput, now = new Date()): boolean {
  if (!subscription) return false;

  if (subscription.status === 'ACTIVE') {
    return true;
  }

  if (subscription.status === 'TRIALING') {
    return !subscription.trialEndsAt || subscription.trialEndsAt > now;
  }

  if (subscription.status === 'PAST_DUE') {
    return Boolean(subscription.currentPeriodEnd && subscription.currentPeriodEnd > pastDueGraceCutoff(now));
  }

  return false;
}
