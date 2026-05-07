-- CreateEnum
CREATE TYPE "ComplianceSignoffStatus" AS ENUM ('DRAFT', 'BOARD_REVIEW', 'APPROVED');

-- CreateTable
CREATE TABLE "ComplianceSignoff" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "reportingYear" INTEGER NOT NULL,
    "status" "ComplianceSignoffStatus" NOT NULL DEFAULT 'DRAFT',
    "boardMeetingDate" TIMESTAMP(3),
    "minuteReference" TEXT,
    "approvedByName" TEXT,
    "approvedByRole" TEXT,
    "approvalNotes" TEXT,
    "approvedAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceSignoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComplianceSignoff_organisationId_reportingYear_idx" ON "ComplianceSignoff"("organisationId", "reportingYear");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceSignoff_organisationId_reportingYear_key" ON "ComplianceSignoff"("organisationId", "reportingYear");

-- AddForeignKey
ALTER TABLE "ComplianceSignoff" ADD CONSTRAINT "ComplianceSignoff_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceSignoff" ADD CONSTRAINT "ComplianceSignoff_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
