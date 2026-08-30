-- Audit trail for governing acts removed from the minute book.
--
-- A fabricated statutory record must be removable, not merely relabelled: a
-- SUPERSEDED row still reads as a real act that once existed. Removing one is
-- itself a governance event, so the act and its resolutions are snapshotted
-- here first, with who removed it and why.
BEGIN;

CREATE TABLE "GoverningActVoid" (
  "id"              TEXT NOT NULL,
  "organisationId"  TEXT NOT NULL,
  "reference"       TEXT NOT NULL,
  "kind"            TEXT NOT NULL,
  "status"          TEXT NOT NULL,
  "actDate"         DATE NOT NULL,
  "title"           TEXT NOT NULL,
  "statutoryBasis"  TEXT,
  "notes"           TEXT,
  "resolutionCount" INTEGER NOT NULL DEFAULT 0,
  "snapshot"        JSONB NOT NULL,
  "reason"          TEXT NOT NULL,
  "voidedByUserId"  TEXT NOT NULL,
  "voidedByEmail"   TEXT NOT NULL,
  "voidedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoverningActVoid_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GoverningActVoid_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "GoverningActVoid_organisationId_idx"
  ON "GoverningActVoid"("organisationId");

CREATE INDEX "GoverningActVoid_organisationId_voidedAt_idx"
  ON "GoverningActVoid"("organisationId", "voidedAt");

COMMIT;
