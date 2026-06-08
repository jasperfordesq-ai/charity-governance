import type { FastifyRequest } from 'fastify';
import { isConfiguredSecret } from '../utils/secrets.js';

const DEFAULT_ALERT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_IN_FLIGHT_ALERTS = 3;
let inFlightAlerts = 0;

export type ErrorAlertPayload = {
  service: 'charitypilot-api';
  environment: string;
  severity: 'error';
  method: string;
  url: string;
  statusCode: number;
  code: string;
  errorName: string;
  requestId: string;
  timestamp: string;
};

export type OperationalErrorAlertInput = {
  job: 'deadline-reminders' | 'document-storage-cleanup';
  code: 'DEADLINE_REMINDERS_FAILED' | 'DOCUMENT_STORAGE_CLEANUP_FAILED';
  error: unknown;
};

function alertTimeoutMs(): number {
  const configured = Number(process.env.ERROR_ALERT_WEBHOOK_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_ALERT_TIMEOUT_MS;
}

function maxInFlightAlerts(): number {
  const configured = Number(process.env.ERROR_ALERT_WEBHOOK_MAX_IN_FLIGHT);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_IN_FLIGHT_ALERTS;
}

function requestPathWithoutQuery(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

type AlertableError = Error & { code?: string };

function errorCode(error: AlertableError): string {
  return typeof error.code === 'string' && error.code.trim() ? error.code : 'INTERNAL_ERROR';
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'Error';
}

export function shouldSendErrorAlert(statusCode: number): boolean {
  return (
    process.env.NODE_ENV === 'production' &&
    statusCode >= 500 &&
    isConfiguredSecret(process.env.ERROR_ALERT_WEBHOOK_URL)
  );
}

export function buildErrorAlertPayload(
  error: AlertableError,
  request: FastifyRequest,
  statusCode: number,
): ErrorAlertPayload {
  return {
    service: 'charitypilot-api',
    environment: process.env.NODE_ENV ?? 'development',
    severity: 'error',
    method: request.method,
    url: requestPathWithoutQuery(request.url),
    statusCode,
    code: errorCode(error),
    errorName: errorName(error),
    requestId: String(request.id),
    timestamp: new Date().toISOString(),
  };
}

export function buildOperationalErrorAlertPayload(input: OperationalErrorAlertInput): ErrorAlertPayload {
  return {
    service: 'charitypilot-api',
    environment: process.env.NODE_ENV ?? 'development',
    severity: 'error',
    method: 'JOB',
    url: `/jobs/${input.job}`,
    statusCode: 500,
    code: input.code,
    errorName: errorName(input.error),
    requestId: `job-${input.job}-${Date.now()}`,
    timestamp: new Date().toISOString(),
  };
}

export async function sendErrorAlert(
  payload: ErrorAlertPayload,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const webhookUrl = process.env.ERROR_ALERT_WEBHOOK_URL;
  if (!isConfiguredSecret(webhookUrl)) return;
  if (inFlightAlerts >= maxInFlightAlerts()) return;

  inFlightAlerts += 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), alertTimeoutMs());

  try {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Error alert webhook returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
    inFlightAlerts -= 1;
  }
}
