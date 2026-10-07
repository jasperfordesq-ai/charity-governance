CREATE TABLE "DocumentPublicationUploadIntent" (
  "id" TEXT NOT NULL,
  "publicationId" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "claimedAt" TIMESTAMP(3) NOT NULL,
  "cloudId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentPublicationUploadIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentPublicationUploadIntent_identity_check" CHECK (
    "id" ~ '^[0-9a-f]{32}$' AND "sha256" ~ '^[0-9a-f]{64}$'
    AND length("cloudId") BETWEEN 1 AND 64
    AND length("spaceId") BETWEEN 1 AND 64
    AND length("pageId") BETWEEN 1 AND 64
    AND length("filename") BETWEEN 1 AND 255
  )
);

CREATE UNIQUE INDEX "DocumentPublicationUploadIntent_publicationId_claimedAt_key"
  ON "DocumentPublicationUploadIntent"("publicationId", "claimedAt");
CREATE INDEX "DocumentPublicationUploadIntent_organisationId_documentId_idx"
  ON "DocumentPublicationUploadIntent"("organisationId", "documentId");
CREATE INDEX "DocumentPublicationUploadIntent_cloudId_pageId_idx"
  ON "DocumentPublicationUploadIntent"("cloudId", "pageId");

-- An upload intent is evidence even when the publication row is later retired.
-- Updating or deleting it would turn an ambiguous remote write into an
-- apparently fresh attempt, so normal application paths cannot do either.
CREATE FUNCTION "DocumentPublicationUploadIntent_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM "DocumentPublication" AS p
      WHERE p.id = NEW."publicationId"
        AND p."organisationId" = NEW."organisationId"
        AND p."documentId" = NEW."documentId"
        AND p.state = 'PENDING'
        AND p."processedAt" IS NULL
        AND p."terminalReason" IS NULL
        AND p."claimedAt" = NEW."claimedAt"
        AND p."remoteWriteStartedAt" IS NOT NULL
        AND p."cloudId" = NEW."cloudId"
        AND p."spaceId" = NEW."spaceId"
        AND p."pageId" = NEW."pageId"
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Upload intent requires the current claimed publication and exact target';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Publication upload intent is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentPublicationUploadIntent_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "DocumentPublicationUploadIntent"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPublicationUploadIntent_guard_fn"();
