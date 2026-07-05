export const DEFAULT_LOCAL_ADMIN_EMAIL = 'admin@charitypilot.local';
export const DEFAULT_LOCAL_ADMIN_NAME = 'Local CharityPilot Admin';
export const DEFAULT_LOCAL_ADMIN_ORGANISATION = 'My Local Charity';

type SeedEnv = Record<string, string | undefined>;

export type LocalAdminSeedConfig = {
  enabled: true;
  email: string;
  name: string;
  organisationName: string;
  password: string;
  subscriptionPlan: 'COMPLETE';
  subscriptionStatus: 'ACTIVE';
};

export function getLocalAdminSeedConfig(env: SeedEnv = process.env): LocalAdminSeedConfig | { enabled: false } {
  const legacyDemoSeed = env.SEED_DEMO_WORKSPACE === 'true';
  const localAdminSeed = env.SEED_LOCAL_ADMIN === 'true';

  if (!legacyDemoSeed && !localAdminSeed) {
    return { enabled: false };
  }

  if (env.NODE_ENV === 'production') {
    throw new Error(localAdminSeed
      ? 'SEED_LOCAL_ADMIN must not be enabled in production'
      : 'SEED_DEMO_WORKSPACE must not be enabled in production');
  }

  const password = localAdminSeed ? env.LOCAL_ADMIN_PASSWORD : env.DEMO_PASSWORD;
  if (!password) {
    throw new Error(localAdminSeed
      ? 'LOCAL_ADMIN_PASSWORD must be set when SEED_LOCAL_ADMIN=true'
      : 'DEMO_PASSWORD must be set when SEED_DEMO_WORKSPACE=true');
  }

  return {
    enabled: true,
    email: localAdminSeed
      ? env.LOCAL_ADMIN_EMAIL ?? DEFAULT_LOCAL_ADMIN_EMAIL
      : 'demo@charitypilot.ie',
    name: localAdminSeed
      ? env.LOCAL_ADMIN_NAME ?? DEFAULT_LOCAL_ADMIN_NAME
      : 'Demo Owner',
    organisationName: localAdminSeed
      ? env.LOCAL_ADMIN_ORGANISATION ?? DEFAULT_LOCAL_ADMIN_ORGANISATION
      : 'CharityPilot Demo Charity',
    password,
    subscriptionPlan: 'COMPLETE',
    subscriptionStatus: 'ACTIVE',
  };
}
