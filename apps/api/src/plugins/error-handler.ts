import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyError } from 'fastify';
import { buildErrorAlertPayload, sendErrorAlert, shouldSendErrorAlert } from '../services/error-alerts.service.js';

export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    app.log.error(error);
    const isProduction = process.env.NODE_ENV === 'production';

    // Handle Fastify validation errors
    if (error.validation) {
      return reply.status(400).send({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: error.validation,
      });
    }

    // Handle rate limit errors
    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: 'Too many requests. Please slow down.',
        code: 'RATE_LIMITED',
      });
    }

    const statusCode = error.statusCode ?? 500;
    const exposeMessage = statusCode < 500 || !isProduction;
    if (shouldSendErrorAlert(statusCode)) {
      const payload = buildErrorAlertPayload(error, request, statusCode);
      void sendErrorAlert(payload).catch((alertError) => {
        app.log.error(alertError, 'Failed to send error alert webhook');
      });
    }

    return reply.status(statusCode).send({
      error: exposeMessage ? error.message : 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      error: 'Route not found',
      code: 'NOT_FOUND',
    });
  });
});
