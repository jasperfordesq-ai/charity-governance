-- Add statutory registers: Register of Members (s.54D Charities Amendment Act 2024) and
-- Register of Directors/Secretary (s.149 Companies Act 2014) extensions.
-- Also adds constitutionPermitsWrittenResolutions to Organisation for sole-member eligibility.

BEGIN;

-- ── DirectorAppointmentKind ────────────────────────────────────────────────────
-- Distinguishes directors appointed by board co-option from those elected by members.

CREATE TYPE "DirectorAppointmentKind" AS ENUM (
  'BOARD',
  'MEMBERS'
);

-- ── Organisation — sole-member written resolution eligibility ──────────────────

ALTER TABLE "Organisation"
  ADD COLUMN "constitutionPermitsWrittenResolutions" BOOLEAN;

-- ── BoardMember — statutory register fields (s.149) ───────────────────────────
-- dateOfBirth, residential address, other directorships, former names, and
-- how the director was appointed are all required by s.149 Companies Act 2014.

ALTER TABLE "BoardMember"
  ADD COLUMN "dateOfBirth"        DATE,
  ADD COLUMN "residentialAddress" TEXT,
  ADD COLUMN "otherDirectorships" TEXT,
  ADD COLUMN "formerNames"        TEXT,
  ADD COLUMN "appointmentKind"    "DirectorAppointmentKind";

-- ── Member — Register of Members (s.54D) ──────────────────────────────────────
-- retentionDeleteAt: computed server-side as dateCeased + 1 year; must not be
-- deleted before then per the one-year post-cessation retention requirement.

CREATE TABLE "Member" (
  "id"                TEXT         NOT NULL,
  "organisationId"    TEXT         NOT NULL,
  "name"              TEXT         NOT NULL,
  "address"           TEXT,
  "dateEntered"       DATE         NOT NULL,
  "dateCeased"        DATE,
  "retentionDeleteAt" DATE,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Member_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Member_organisationId_fkey" FOREIGN KEY ("organisationId")
    REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "Member_organisationId_idx"            ON "Member"("organisationId");
CREATE INDEX "Member_organisationId_dateCeased_idx" ON "Member"("organisationId", "dateCeased");

COMMIT;
