import type { FastifyInstance } from 'fastify';
import { DocumentService } from '../../services/document.service.js';
import { StorageService } from '../../services/storage.service.js';
import { authGuard } from '../../middleware/auth.js';
import { subscriptionGuard } from '../../middleware/subscription.js';
import { requireAdmin } from '../../middleware/roles.js';
import { uploadDocumentSchema, linkStandardSchema } from '@charitypilot/shared';
import { AppError, handleError } from '../../utils/errors.js';
import { sendCreated, sendNoContent } from '../../utils/response.js';
import { formatProviderError } from '../../utils/provider-errors.js';
import { ZodError } from 'zod';
import {
  DOCUMENT_UPLOAD_MAX_FILE_SIZE,
  DOCUMENT_UPLOAD_MULTIPART_LIMITS,
  hasAllowedExtension,
  hasAllowedMimeType,
  hasValidSignature,
  isFileTooLargeError,
  isMultipartLimitError,
} from './document-upload-validation.js';

export { DOCUMENT_UPLOAD_MAX_FILE_SIZE, DOCUMENT_UPLOAD_MULTIPART_LIMITS } from './document-upload-validation.js';

function safeDownloadFilename(name: string, storagePath: string): string {
  const storedFilename = storagePath.split('/').pop() ?? '';
  const storedExtension = storedFilename.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? '';
  const candidate = name || storedFilename || 'document';
  const safeBase = candidate
    .replace(/[\u0000-\u001f\u007f<>:"\\/|?*]/g, '-')
    .replace(/[^\x20-\x7e]/g, '-')
    .replace(/-{2,}/g, '-')
    .trim()
    .slice(0, 180)
    .replace(/[. ]+$/g, '');
  const safe = safeBase || 'document';
  return storedExtension && !safe.toLowerCase().endsWith(storedExtension.toLowerCase())
    ? `${safe.slice(0, 180 - storedExtension.length).replace(/[. ]+$/g, '') || 'document'}${storedExtension}`
    : safe;
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

  // Authenticated proxy download: storage capabilities never leave the API.
  app.get<{ Params: { id: string } }>('/:id/download', async (request, reply) => {
    try {
      const descriptor = await service.getDownloadDescriptor(
        request.user.organisationId,
        request.params.id,
      );
      const file = await storageService.downloadFile(
        request.user.organisationId,
        descriptor.storagePath,
      );

      // Storage reads can take long enough for an administrator to offboard the
      // caller. Revalidate after provider I/O so a completed revocation wins.
      const activeSession = await app.prisma.authSession.findFirst({
        where: {
          id: request.user.sessionId,
          userId: request.user.userId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          user: {
            is: {
              organisationId: request.user.organisationId,
              lifecycleStatus: 'ACTIVE',
              organisation: { is: { lifecycleStatus: 'ACTIVE' } },
            },
          },
        },
        select: { id: true },
      });
      if (!activeSession) {
        throw new AppError(401, 'UNAUTHORIZED', 'Your authenticated session is no longer active');
      }

      const filename = safeDownloadFilename(descriptor.name, descriptor.storagePath);
      return reply
        .type(hasAllowedMimeType(descriptor.mimeType) ? descriptor.mimeType : 'application/octet-stream')
        .header('Cache-Control', 'private, no-store, max-age=0')
        .header('Pragma', 'no-cache')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(file);
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

          if (!hasAllowedMimeType(part.mimetype)) {
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
