import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

export class DocumentService {
  constructor(private prisma: PrismaClient) {}

  async list(organisationId: string) {
    return this.prisma.document.findMany({
      where: { organisationId },
      include: {
        standardLinks: {
          include: { standard: { select: { id: true, code: true } } },
        },
        uploadedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(organisationId: string, id: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id, organisationId },
      include: {
        standardLinks: {
          include: { standard: { select: { id: true, code: true } } },
        },
        uploadedBy: { select: { id: true, name: true } },
      },
    });

    if (!doc) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }

    return doc;
  }

  async create(
    organisationId: string,
    userId: string,
    data: {
      name: string;
      description?: string;
      category: string;
      /** Storage path within Supabase Storage (used as fileUrl column) */
      fileUrl: string;
      fileSize: number;
      mimeType: string;
    },
  ) {
    return this.prisma.document.create({
      data: {
        organisationId,
        uploadedById: userId,
        name: data.name,
        description: data.description,
        category: data.category as never,
        fileUrl: data.fileUrl,
        fileSize: data.fileSize,
        mimeType: data.mimeType,
      },
      include: {
        standardLinks: {
          include: { standard: { select: { id: true, code: true } } },
        },
      },
    });
  }

  /**
   * Deletes the document record from the database and returns the stored
   * `fileUrl` (Supabase storage path) so the caller can remove the file
   * from object storage.
   */
  async remove(organisationId: string, id: string): Promise<string> {
    const doc = await this.prisma.document.findFirst({
      where: { id, organisationId },
    });

    if (!doc) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }

    await this.prisma.document.delete({ where: { id } });

    return doc.fileUrl;
  }

  async linkStandard(organisationId: string, documentId: string, standardId: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, organisationId },
    });

    if (!doc) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }

    return this.prisma.documentStandardLink.create({
      data: { documentId, standardId },
    });
  }

  async unlinkStandard(organisationId: string, documentId: string, standardId: string) {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, organisationId },
    });

    if (!doc) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
    }

    await this.prisma.documentStandardLink.deleteMany({
      where: { documentId, standardId },
    });
  }
}
