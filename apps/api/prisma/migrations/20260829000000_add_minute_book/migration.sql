-- Add minute book: GoverningAct + Resolution models, and evidence fields on Document.
-- Corresponds to Priority 1 of the 2026-08-29 governance audit handoff.

BEGIN;

CREATE TYPE "GoverningActKind" AS ENUM (
  'BOARD_MEETING',
  'DIRECTORS_WRITTEN_RESOLUTION',
  'MEMBER_WRITTEN_RESOLUTION',
  'ANNUAL_GENERAL_MEETING',
  'EXTRAORDINARY_GENERAL_MEETING'
);

CREATE TYPE "GoverningActStatus" AS ENUM (
  'SCHEDULED',
  'HELD',
  'DRAFT',
  'CIRCULATED',
  'APPROVED',
  'SUPERSEDED'
);

CREATE TABLE "GoverningAct" (
  "id"              TEXT          NOT NULL,
  "organisationId"  TEXT          NOT NULL,
  "kind"            "GoverningActKind" NOT NULL,
  "status"          "GoverningActStatus" NOT NULL DEFAULT 'SCHEDULED',
  "actDate"         DATE          NOT NULL,
  "reference"       TEXT          NOT NULL,
  "title"           TEXT          NOT NULL,
  "statutoryBasis"  TEXT,
  "approvedAtActId" TEXT,
  "approvedAt"      TIMESTAMP(3),
  "documentId"      TEXT,
  "notes"           TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GoverningAct_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GoverningAct_organisationId_reference_key" UNIQUE ("organisationId", "reference"),
  CONSTRAINT "GoverningAct_organisationId_fkey" FOREIGN KEY ("organisationId")
    REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "GoverningAct_approvedAtActId_fkey" FOREIGN KEY ("approvedAtActId")
    REFERENCES "GoverningAct"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "GoverningAct_organisationId_idx"         ON "GoverningAct"("organisationId");
CREATE INDEX "GoverningAct_organisationId_actDate_idx" ON "GoverningAct"("organisationId", "actDate");

CREATE TABLE "Resolution" (
  "id"               TEXT    NOT NULL,
  "organisationId"   TEXT    NOT NULL,
  "governingActId"   TEXT    NOT NULL,
  "itemNumber"       TEXT,
  "text"             TEXT    NOT NULL,
  "carried"          BOOLEAN NOT NULL DEFAULT TRUE,
  "abstentions"      TEXT,
  "conflictRecordId" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Resolution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Resolution_governingActId_fkey" FOREIGN KEY ("governingActId")
    REFERENCES "GoverningAct"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Resolution_organisationId_idx"  ON "Resolution"("organisationId");
CREATE INDEX "Resolution_governingActId_idx"  ON "Resolution"("governingActId");

-- Add evidence fields to Document.
-- approvalAsserted: the user has claimed approval exists but cannot supply the resolution.
-- approvedByResolutionId: FK to the Resolution that is the evidence of approval.
-- Neither field removes the existing approvedDate/boardMinuteReference — those are
-- kept as denormalised display values and must be backfilled from the resolution.
ALTER TABLE "Document"
  ADD COLUMN "approvalAsserted"       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "approvedByResolutionId" TEXT,
  ADD CONSTRAINT "Document_approvedByResolutionId_fkey"
    FOREIGN KEY ("approvedByResolutionId") REFERENCES "Resolution"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
