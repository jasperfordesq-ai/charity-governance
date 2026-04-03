import type { PrismaClient } from '@prisma/client';

export interface ActivityItem {
  id: string;
  type: 'compliance_update' | 'document_upload' | 'board_member_change' | 'deadline_change';
  description: string;
  timestamp: string;
  userId?: string;
  userName?: string;
}

export class ActivityService {
  constructor(private prisma: PrismaClient) {}

  async getRecentActivity(organisationId: string, limit = 20): Promise<ActivityItem[]> {
    const [complianceRecords, documents, boardMembers, deadlines] = await Promise.all([
      this.prisma.complianceRecord.findMany({
        where: { organisationId },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        include: {
          standard: { select: { code: true } },
          updatedBy: { select: { id: true, name: true } },
        },
      }),
      this.prisma.document.findMany({
        where: { organisationId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          uploadedBy: { select: { id: true, name: true } },
        },
      }),
      this.prisma.boardMember.findMany({
        where: { organisationId },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      }),
      this.prisma.deadline.findMany({
        where: { organisationId },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      }),
    ]);

    const items: ActivityItem[] = [];

    for (const record of complianceRecords) {
      const statusLabel = record.status.replace(/_/g, ' ').toLowerCase();
      items.push({
        id: `compliance-${record.id}`,
        type: 'compliance_update',
        description:
          record.status === 'NOT_STARTED'
            ? `Updated compliance record for standard ${record.standard.code}`
            : `Marked standard ${record.standard.code} as ${statusLabel}`,
        timestamp: record.updatedAt.toISOString(),
        userId: record.updatedBy?.id,
        userName: record.updatedBy?.name,
      });
    }

    for (const doc of documents) {
      items.push({
        id: `document-${doc.id}`,
        type: 'document_upload',
        description: `Uploaded document '${doc.name}'`,
        timestamp: doc.createdAt.toISOString(),
        userId: doc.uploadedBy?.id,
        userName: doc.uploadedBy?.name,
      });
    }

    for (const member of boardMembers) {
      items.push({
        id: `board-member-${member.id}`,
        type: 'board_member_change',
        description: `Updated board member '${member.name}'`,
        timestamp: member.updatedAt.toISOString(),
      });
    }

    for (const deadline of deadlines) {
      items.push({
        id: `deadline-${deadline.id}`,
        type: 'deadline_change',
        description: `Updated deadline '${deadline.title}'`,
        timestamp: deadline.updatedAt.toISOString(),
      });
    }

    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return items.slice(0, limit);
  }
}
