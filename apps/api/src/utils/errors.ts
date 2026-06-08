import type { FastifyReply } from 'fastify';
import { buildErrorAlertPayload, sendErrorAlert, shouldSendErrorAlert } from '../services/error-alerts.service.js';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function alertForHandledError(reply: FastifyReply, error: Error & { code?: string }, statusCode: number): void {
  if (!shouldSendErrorAlert(statusCode)) return;

  const payload = buildErrorAlertPayload(error, reply.request, statusCode);
  void sendErrorAlert(payload).catch((alertError) => {
    reply.request.log.error(alertError, 'Failed to send error alert webhook');
  });
}

export function sendError(reply: FastifyReply, error: AppError): void {
  alertForHandledError(reply, error, error.statusCode);

  const exposeMessage = error.statusCode < 500 || !isProduction();
  const payload: {
    error: string;
    code: string;
    details?: unknown;
  } = {
    error: exposeMessage ? error.message : 'Internal server error',
    code: exposeMessage ? error.code : 'INTERNAL_ERROR',
  };

  if (error.details !== undefined && exposeMessage) {
    payload.details = error.details;
  }

  reply.status(error.statusCode).send(payload);
}

export function handleError(reply: FastifyReply, err: unknown): void {
  if (err instanceof AppError) {
    sendError(reply, err);
    return;
  }

  const error = err instanceof Error ? err : new Error('Unexpected non-error exception');
  alertForHandledError(reply, error, 500);

  reply.status(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
}
