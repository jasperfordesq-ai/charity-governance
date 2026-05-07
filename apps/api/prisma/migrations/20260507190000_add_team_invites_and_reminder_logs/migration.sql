-- CreateEnum
CREATE TYPE "DeadlineReminderStatus" AS ENUM ('SENT', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "TeamInvite" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
    "token" TEXT NOT NULL,
    "invitedById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadlineReminderLog" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "deadlineId" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "reminderDays" INTEGER NOT NULL,
    "status" "DeadlineReminderStatus" NOT NULL,
    "error" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeadlineReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamInvite_token_key" ON "TeamInvite"("token");

-- CreateIndex
CREATE INDEX "TeamInvite_organisationId_idx" ON "TeamInvite"("organisationId");

-- CreateIndex
CREATE INDEX "TeamInvite_email_idx" ON "TeamInvite"("email");

-- CreateIndex
CREATE UNIQUE INDEX "DeadlineReminderLog_deadlineId_email_reminderDays_key" ON "DeadlineReminderLog"("deadlineId", "email", "reminderDays");

-- CreateIndex
CREATE INDEX "DeadlineReminderLog_organisationId_idx" ON "DeadlineReminderLog"("organisationId");

-- CreateIndex
CREATE INDEX "DeadlineReminderLog_userId_idx" ON "DeadlineReminderLog"("userId");

-- AddForeignKey
ALTER TABLE "TeamInvite" ADD CONSTRAINT "TeamInvite_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamInvite" ADD CONSTRAINT "TeamInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadlineReminderLog" ADD CONSTRAINT "DeadlineReminderLog_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadlineReminderLog" ADD CONSTRAINT "DeadlineReminderLog_deadlineId_fkey" FOREIGN KEY ("deadlineId") REFERENCES "Deadline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadlineReminderLog" ADD CONSTRAINT "DeadlineReminderLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
