const DEFAULT_PRODUCTION_API_URL = 'https://api.charitypilot.ie';
const DEFAULT_DEVELOPMENT_API_URL = 'http://localhost:3002';

type ApiEnv = {
  NEXT_PUBLIC_API_URL?: string;
  NODE_ENV?: string;
};

export function getApiBaseUrl(env: ApiEnv = process.env): string {
  const configuredUrl = env.NEXT_PUBLIC_API_URL?.trim();

  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, '');
  }

  if (env.NODE_ENV === 'production') {
    return DEFAULT_PRODUCTION_API_URL;
  }

  return DEFAULT_DEVELOPMENT_API_URL;
}
