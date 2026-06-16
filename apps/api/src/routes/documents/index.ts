import type { FastifyInstance } from 'fastify';
import { DocumentService } from '../../services/document.service.js';
import { StorageService } from '../../services/storage.service.js';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { requireAdmin } from '../../middleware/roles.js';
import { uploadDocumentSchema, linkStandardSchema } from '@charitypilot/shared';
import { handleError } from '../../utils/errors.js';
import { sendCreated, sendNoContent } from '../../utils/response.js';
import { formatProviderError } from '../../utils/provider-errors.js';
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

export const DOCUMENT_UPLOAD_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
export const DOCUMENT_UPLOAD_MULTIPART_LIMITS = {
  fileSize: DOCUMENT_UPLOAD_MAX_FILE_SIZE,
  files: 1,
  fields: 7,
  parts: 8,
  fieldNameSize: 64,
  fieldSize: 4 * 1024,
  headerPairs: 50,
} as const;

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

function isMultipartLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT' || code === 'FST_FILES_LIMIT';
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

  app.get('/_local-download', async (request, reply) => {
    try {
      const { path } = request.query as { path?: string };
      if (!path) {
        return reply.status(400).send({ error: 'Missing local storage path', code: 'LOCAL_STORAGE_PATH_REQUIRED' });
      }

      const file = await storageService.readLocalFile(request.user.organisationId, path);
      const filename = path.split('/').pop()?.replace(/["\r\n]/g, '') || 'document';

      return reply
        .type('application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(file);
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
      const storagePath = await service.getStoragePath(request.user.organisationId, request.params.id);
      const url = await storageService.getSignedUrl(request.user.organisationId, storagePath);
      return reply.send({ url });
    } catch (err) {
      handleError(reply, err);
    }
  });

  // Upload document (multipart/form-data)
  app.post('/', { preHandler: [requireAdmin] }, async (request, reply) => {
    try {
      const fields: Record<string, { value?: string }> = {};
      let uploadedFile: { filename: string; mimetype: string; buffer: Buffer } | null = null;
      let partCount = 0;
      let fieldCount = 0;
      let fileCount = 0;

      try {
        for await (const part of request.parts()) {
          partCount += 1;
          if (partCount > DOCUMENT_UPLOAD_MULTIPART_LIMITS.parts) {
            return reply.status(413).send({
              error: 'Multipart upload exceeds the document request limits.',
              code: 'MULTIPART_LIMIT_EXCEEDED',
            });
          }

          if (part.type === 'field') {
            fieldCount += 1;
            const fieldValue = typeof part.value === 'string' ? part.value : String(part.value ?? '');

            if (
              fieldCount > DOCUMENT_UPLOAD_MULTIPART_LIMITS.fields ||
              part.fieldnameTruncated ||
              part.valueTruncated ||
              Buffer.byteLength(part.fieldname) > DOCUMENT_UPLOAD_MULTIPART_LIMITS.fieldNameSize ||
              Buffer.byteLength(fieldValue) > DOCUMENT_UPLOAD_MULTIPART_LIMITS.fieldSize
            ) {
              return reply.status(413).send({
                error: 'Multipart upload exceeds the document request limits.',
                code: 'MULTIPART_LIMIT_EXCEEDED',
              });
            }

            fields[part.fieldname] = {
              value: fieldValue,
            };
            continue;
          }

          fileCount += 1;
          if (fileCount > DOCUMENT_UPLOAD_MULTIPART_LIMITS.files || uploadedFile) {
            return reply.status(413).send({
              error: 'Multipart upload exceeds the document request limits.',
              code: 'MULTIPART_LIMIT_EXCEEDED',
            });
          }

          if (!ALLOWED_MIME_TYPES.has(part.mimetype)) {
            return reply.status(400).send({
              error: `File type '${part.mimetype}' is not allowed. Accepted types: PDF, modern Office documents, text, CSV, JPEG, PNG.`,
              code: 'INVALID_MIME_TYPE',
            });
          }

          const buffer = await part.toBuffer();
          if (buffer.length > DOCUMENT_UPLOAD_MAX_FILE_SIZE) {
            return reply.status(413).send({
              error: 'File size exceeds the 10 MB limit.',
              code: 'FILE_TOO_LARGE',
            });
          }

          uploadedFile = {
            filename: part.filename,
            mimetype: part.mimetype,
            buffer,
          };
        }
      } catch (error) {
        if (isFileTooLargeError(error)) {
          return reply.status(413).send({
            error: 'File size exceeds the 10 MB limit.',
            code: 'FILE_TOO_LARGE',
          });
        }
        if (isMultipartLimitError(error)) {
          return reply.status(413).send({
            error: 'Multipart upload exceeds the document request limits.',
            code: 'MULTIPART_LIMIT_EXCEEDED',
          });
        }
        throw error;
      }

      if (!uploadedFile) {
        return reply.status(400).send({ error: 'No file uploaded', code: 'NO_FILE' });
      }

      const meta = uploadDocumentSchema.parse({
        name: fields.name?.value,
        description: fields.description?.value,
        category: fields.category?.value,
        owner: fields.owner?.value,
        approvedDate: fields.approvedDate?.value,
        nextReviewDate: fields.nextReviewDate?.value,
        boardMinuteReference: fields.boardMinuteReference?.value,
      });

      if (!hasAllowedExtension(uploadedFile.filename, uploadedFile.mimetype) || !hasValidSignature(uploadedFile.mimetype, uploadedFile.buffer)) {
        return reply.status(400).send({
          error: 'File content does not match the declared document type.',
          code: 'INVALID_FILE_SIGNATURE',
        });
      }

      const { storagePath } = await storageService.uploadFile(
        request.user.organisationId,
        uploadedFile.filename,
        uploadedFile.buffer,
        uploadedFile.mimetype,
      );

      let doc;
      try {
        doc = await service.create(request.user.organisationId, request.user.userId, {
          name: meta.name,
          description: meta.description,
          category: meta.category,
          fileUrl: storagePath,
          fileSize: uploadedFile.buffer.length,
          mimeType: uploadedFile.mimetype,
          owner: meta.owner || null,
          approvedDate: meta.approvedDate || null,
          nextReviewDate: meta.nextReviewDate || null,
          boardMinuteReference: meta.boardMinuteReference || null,
        });
      } catch (error) {
        try {
          await storageService.deleteFile(request.user.organisationId, storagePath);
        } catch (cleanupError) {
          request.log.error(
            { providerError: formatProviderError(cleanupError) },
            'Failed to clean up uploaded document after database create failed',
          );
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
      const deleted = await service.remove(request.user.organisationId, request.params.id);
      try {
        await storageService.deleteFile(request.user.organisationId, deleted.storagePath);
        await service.markStorageDeletionProcessed(deleted.storageDeletionId);
      } catch (cleanupError) {
        try {
          await service.recordStorageDeletionFailure(deleted.storageDeletionId, cleanupError);
        } catch (outboxError) {
          request.log.error(
            { providerError: formatProviderError(outboxError) },
            'Failed to update document storage cleanup retry record',
          );
        }
        request.log.error(
          { providerError: formatProviderError(cleanupError) },
          'Failed to clean up document storage after database delete succeeded',
        );
      }
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
