-- A document's approval must name the Confluence site and space whose
-- audience was reviewed. Existing booleans cannot prove which destination
-- was reviewed, so withdraw them conservatively and record that system act.
ALTER TABLE "Document"
  ADD COLUMN "externalPublicationSiteId" TEXT,
  ADD COLUMN "externalPublicationSpaceId" TEXT;

INSERT INTO "DocumentControlAudit" (
  "id", "organisationId", "documentId", "actorUserId", "kind",
  "previous", "next", "reason"
)
SELECT gen_random_uuid()::text, "organisationId", "id",
  'system:publication-destination-migration', 'PUBLICATION', 'true', 'false',
  'Legacy publication approval lacked a recorded Confluence site and space; review the destination and approve again.'
FROM "Document"
WHERE "externalPublicationApproved" = true;

UPDATE "Document"
SET "externalPublicationApproved" = false
WHERE "externalPublicationApproved" = true;

ALTER TABLE "Document"
  ADD CONSTRAINT "Document_publication_approval_destination_consistent"
  CHECK (
    ("externalPublicationApproved" = false
      AND "externalPublicationSiteId" IS NULL
      AND "externalPublicationSpaceId" IS NULL)
    OR
    ("externalPublicationApproved" = true
      AND "externalPublicationSiteId" IS NOT NULL
      AND "externalPublicationSpaceId" IS NOT NULL
      AND "externalPublicationSiteId" = btrim("externalPublicationSiteId")
      AND "externalPublicationSpaceId" = btrim("externalPublicationSpaceId")
      AND char_length("externalPublicationSiteId") BETWEEN 1 AND 200
      AND char_length("externalPublicationSpaceId") BETWEEN 1 AND 200)
  );

ALTER TABLE "DocumentControlAudit"
  DROP CONSTRAINT "DocumentControlAudit_kind_valid";
ALTER TABLE "DocumentControlAudit"
  ADD CONSTRAINT "DocumentControlAudit_kind_valid"
  CHECK ("kind" IN (
    'LIFECYCLE', 'PUBLICATION', 'PUBLICATION_TARGET', 'BOARD_APPROVAL',
    'METADATA', 'UPLOAD', 'RECORD_DELETE', 'STANDARD_LINK', 'STANDARD_UNLINK',
    'REPLACEMENT', 'DELETION_HOLD', 'CONFLUENCE_REFERENCE', 'STORAGE_PROVIDER'
  ));
