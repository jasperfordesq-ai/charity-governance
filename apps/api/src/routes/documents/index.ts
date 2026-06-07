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
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'image/jpeg',
  'image/png',
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const MIME_EXTENSIONS: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'text/plain': ['.txt'],
  'text/csv': ['.csv'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
};

function hasZipSignature(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}

function hasTextSignature(buffer: Buffer): boolean {
  return !buffer.includes(0);
}

function hasValidSignature(mimeType: string, buffer: Buffer): boolean {
  switch (mimeType) {
    case 'application/pdf':
      return buffer.subarray(0, 5).toString('utf8') === '%PDF-';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return hasZipSignature(buffer);
    case 'image/jpeg':
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'image/png':
      return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'text/plain':
    case 'text/csv':
      return hasTextSignature(buffer);
    default:
      return false;
  }
}

function hasAllowedExtension(filename: string, mimeType: string): boolean {
  const lowerFilename = filename.toLowerCase();
  return (MIME_EXTENSIONS[mimeType] ?? []).some((extension) => lowerFilename.endsWith(extension));
}

function isFileTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : '';
  return code === 'FST_REQ_FILE_TOO_LARGE' || /file.*too large|request file too large/i.test(message);
}

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
      const url = await storageService.getSignedUrl(request.user.organisationId, doc.fileUrl);
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
          error: `File type '${data.mimetype}' is not allowed. Accepted types: PDF, modern Office documents, text, CSV, JPEG, PNG.`,
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

      let buffer: Buffer;
      try {
        buffer = await data.toBuffer();
      } catch (error) {
        if (isFileTooLargeError(error)) {
          return reply.status(413).send({
            error: 'File size exceeds the 10 MB limit.',
            code: 'FILE_TOO_LARGE',
          });
        }
        throw error;
      }

      if (buffer.length > MAX_FILE_SIZE) {
        return reply.status(413).send({
          error: 'File size exceeds the 10 MB limit.',
          code: 'FILE_TOO_LARGE',
        });
      }

      if (!hasAllowedExtension(data.filename, data.mimetype) || !hasValidSignature(data.mimetype, buffer)) {
        return reply.status(400).send({
          error: 'File content does not match the declared document type.',
          code: 'INVALID_FILE_SIGNATURE',
        });
      }

      const { storagePath } = await storageService.uploadFile(
        request.user.organisationId,
        data.filename,
        buffer,
        data.mimetype,
      );

      let doc;
      try {
        doc = await service.create(request.user.organisationId, request.user.userId, {
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
      } catch (error) {
        try {
          await storageService.deleteFile(request.user.organisationId, storagePath);
        } catch (cleanupError) {
          request.log.error(cleanupError, 'Failed to clean up uploaded document after database create failed');
        }
        throw error;
      }

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
      const doc = await service.getById(request.user.organisationId, request.params.id);
      await storageService.deleteFile(request.user.organisationId, doc.fileUrl);
      await service.remove(request.user.organisationId, request.params.id);
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
