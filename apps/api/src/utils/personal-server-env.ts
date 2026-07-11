import { posix, win32 } from 'node:path';
import { AppError } from './errors.js';
import { validateProductionEnv } from './env.js';
import { parsePort } from './port.js';
import { isConfiguredSecret } from './secrets.js';
import {
  getPersonalServerOrigin,
  isPersonalServerDeployment,
  PERSONAL_SERVER_DEPLOYMENT_MODE,
} from './personal-server.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const LOCAL_DATABASE_HOSTS = new Set(['db', 'localhost', '127.0.0.1', '::1']);

function requireStrongSecret(name: string, issues: string[]): string | undefined {
  const value = process.env[name];
  if (!isConfiguredSecret(value) || value.length < 32 || CONTROL_CHARACTERS.test(value)) {
    issues.push(`${name} must be a configured secret of at least 32 characters`);
    return undefined;
  }
  return value;
}

function requirePersonalDatabaseUrl(issues: string[]): void {
  const value = process.env.DATABASE_URL;
  if (!isConfiguredSecret(value)) {
    issues.push('DATABASE_URL must be configured for the local PostgreSQL service');
    return;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
      issues.push('DATABASE_URL must use a PostgreSQL connection URL');
    }
    if (!LOCAL_DATABASE_HOSTS.has(hostname)) {
      issues.push('DATABASE_URL must use the local PostgreSQL service host db or an exact loopback host');
    }
    if (!url.username || !url.password) {
      issues.push('DATABASE_URL must include a database username and password');
    }
    if (!url.pathname || url.pathname === '/' || url.hash) {
      issues.push('DATABASE_URL must select one local database and must not contain a fragment');
    }
  } catch {
    issues.push('DATABASE_URL must be a valid PostgreSQL connection URL');
  }
}

function requireAbsoluteLocalStoragePath(issues: string[]): void {
  if (process.env.DOCUMENT_STORAGE_DRIVER !== 'local') {
    issues.push('DOCUMENT_STORAGE_DRIVER must be exactly local for personal-server mode');
  }

  const value = process.env.LOCAL_FILE_STORAGE_DIR;
  if (
    !value ||
    value.trim() !== value ||
    CONTROL_CHARACTERS.test(value) ||
    (!posix.isAbsolute(value) && !win32.isAbsolute(value)) ||
    value === posix.parse(value).root ||
    value === win32.parse(value).root
  ) {
    issues.push('LOCAL_FILE_STORAGE_DIR must be an absolute non-root filesystem path');
  }
}

export function validatePersonalServerEnv(): void {
  const issues: string[] = [];

  if (process.env.NODE_ENV !== 'production') {
    issues.push('NODE_ENV must be production for personal-server mode');
  }
  if (process.env.CHARITYPILOT_DEPLOYMENT_MODE !== PERSONAL_SERVER_DEPLOYMENT_MODE) {
    issues.push(`CHARITYPILOT_DEPLOYMENT_MODE must be ${PERSONAL_SERVER_DEPLOYMENT_MODE}`);
  }

  try {
    if (!process.env.PORT) issues.push('PORT must be configured');
    parsePort(process.env.PORT, 3002);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'PORT must be an integer from 1 to 65535');
  }

  const origin = getPersonalServerOrigin();
  if (!origin) {
    issues.push(
      'FRONTEND_URL and NEXT_PUBLIC_API_URL must be the same exact origin using HTTPS with a DNS hostname or HTTP with an exact loopback host',
    );
  }

  const jwtSecret = requireStrongSecret('JWT_SECRET', issues);
  const readinessSecret = requireStrongSecret('READINESS_API_KEY', issues);
  if (jwtSecret && readinessSecret && jwtSecret === readinessSecret) {
    issues.push('JWT_SECRET and READINESS_API_KEY must be distinct secrets');
  }

  requirePersonalDatabaseUrl(issues);
  requireAbsoluteLocalStoragePath(issues);

  if (process.env.AUTH_COOKIE_DOMAIN?.trim()) {
    issues.push('AUTH_COOKIE_DOMAIN must be unset in personal-server mode');
  }
  if (process.env.SELF_REGISTRATION_ENABLED !== 'false') {
    issues.push('SELF_REGISTRATION_ENABLED must be exactly false in personal-server mode');
  }

  if (issues.length) {
    throw new AppError(
      500,
      'PERSONAL_SERVER_ENV_INVALID',
      'Personal server environment is not ready',
      issues,
    );
  }
}

export function validateRuntimeEnv(): void {
  if (isPersonalServerDeployment()) {
    validatePersonalServerEnv();
    return;
  }

  validateProductionEnv();
}
