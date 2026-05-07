import type { FastifyInstance } from 'fastify';
import { DocumentService } from '../../services/document.service.js';
import { StorageService } from '../../services/storage.service.js';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { requireAdmin } from '../../middleware/roles.js';
import { uploadDocumentSchema, linkStandardSchema } from '@charitypilot/shared';
import { handleError } from '../../utils/errors.js';
import { sendCreated, sendNoContent } from '../../utils/response.js';
import { ZodError } from 'zod';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'image/jpeg',
  'image/png',
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export async function documentRoutes(app: FastifyInstance) {
  const service = new DocumentService(app.prisma);
  const storageService = new StorageService();

  app.addHook('onRequest', authGuard);
  app.addHook('onRequest', subscriptionGuard);

  app.get('/', async (request, reply) => {
    try {
      const { page, pageSize } = request.query as { page?: string; pageSize?: string };
      return await service.list(
        request.user.organisationId,
        Math.max(1, parseInt(page ?? '1', 10) || 1),
        Math.min(100, Math.max(1, parseInt(pageSize ?? '50', 10) || 50)),
      );
    } catch (err) {
      handleError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    try {
      return await service.getById(request.user.organisationId, request.params.id);
    } catch (err) {
      handleError(reply, err);
    }
  });

  // GET /api/v1/documents/:id/download — returns a time-limited signed URL
  app.get<{ Params: { id: string } }>('/:id/download', async (request, reply) => {
    try {
      const doc = await service.getById(request.user.organisationId, request.params.id);
      const url = await storageService.getSignedUrl(doc.fileUrl);
      return reply.send({ url });
    } catch (err) {
      handleError(reply, err);
    }
  });

  // Upload document (multipart/form-data)
  app.post('/', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded', code: 'NO_FILE' });
      }

      if (!ALLOWED_MIME_TYPES.has(data.mimetype)) {
        return reply.status(400).send({
          error: `File type '${data.mimetype}' is not allowed. Accepted types: PDF, Word, Excel, PowerPoint, text, CSV, JPEG, PNG.`,
          code: 'INVALID_MIME_TYPE',
        });
      }

      const fields = data.fields as Record<string, { value?: string }>;
      const meta = uploadDocumentSchema.parse({
        name: fields.name?.value,
        description: fields.description?.value,
        category: fields.category?.value,
        owner: fields.owner?.value,
        approvedDate: fields.approvedDate?.value,
        nextReviewDate: fields.nextReviewDate?.value,
        boardMinuteReference: fields.boardMinuteReference?.value,
      });

      const buffer = await data.toBuffer();

      if (buffer.length > MAX_FILE_SIZE) {
        return reply.status(400).send({
          error: 'File size exceeds the 10 MB limit.',
          code: 'FILE_TOO_LARGE',
        });
      }

      const { storagePath } = await storageService.uploadFile(
        request.user.organisationId,
        data.filename,
        buffer,
        data.mimetype,
      );

      const doc = await service.create(request.user.organisationId, request.user.userId, {
        name: meta.name,
        description: meta.description,
        category: meta.category,
        fileUrl: storagePath,
        fileSize: buffer.length,
        mimeType: data.mimetype,
        owner: meta.owner || null,
        approvedDate: meta.approvedDate || null,
        nextReviewDate: meta.nextReviewDate || null,
        boardMinuteReference: meta.boardMinuteReference || null,
      });

      return sendCreated(reply, doc);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const storagePath = await service.remove(request.user.organisationId, request.params.id);
      await storageService.deleteFile(storagePath);
      return sendNoContent(reply);
    } catch (err) {
      handleError(reply, err);
    }
  });

  // Link document to governance standard
  app.post<{ Params: { id: string } }>('/:id/link-standard', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const { standardId } = linkStandardSchema.parse(request.body);
      await service.linkStandard(request.user.organisationId, request.params.id, standardId);
      return sendCreated(reply, { success: true });
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });

  // Alias used by the web app: POST /documents/:id/standards
  app.post<{ Params: { id: string } }>('/:id/standards', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const { standardId } = linkStandardSchema.parse(request.body);
      await service.linkStandard(request.user.organisationId, request.params.id, standardId);
      return sendCreated(reply, { success: true });
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });

  // Unlink document from governance standard
  app.delete<{ Params: { id: string } }>('/:id/unlink-standard', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const { standardId } = linkStandardSchema.parse(request.body);
      await service.unlinkStandard(request.user.organisationId, request.params.id, standardId);
      return sendNoContent(reply);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: err.errors });
      }
      handleError(reply, err);
    }
  });

  // Alias used by the web app: DELETE /documents/:id/standards/:standardId
  app.delete<{ Params: { id: string; standardId: string } }>('/:id/standards/:standardId', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      await service.unlinkStandard(
        request.user.organisationId,
        request.params.id,
        request.params.standardId,
      );
      return sendNoContent(reply);
    } catch (err) {
      handleError(reply, err);
    }
  });
}
