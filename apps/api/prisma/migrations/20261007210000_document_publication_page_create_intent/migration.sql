BEGIN;

CREATE TABLE "DocumentPublicationPageCreateIntent" (
  "id" TEXT NOT NULL,
  "publicationId" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "claimedAt" TIMESTAMP(3) NOT NULL,
  "documentRevision" TIMESTAMP(3) NOT NULL,
  "cloudId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "parentPageId" TEXT,
  "title" TEXT NOT NULL,
  "bodySha256" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentPublicationPageCreateIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentPublicationPageCreateIntent_identity_check" CHECK (
    "id" ~ '^[0-9a-f]{32}$' AND "bodySha256" ~ '^[0-9a-f]{64}$'
    AND length("cloudId") BETWEEN 1 AND 64 AND "cloudId" = btrim("cloudId")
    AND length("spaceId") BETWEEN 1 AND 64 AND "spaceId" = btrim("spaceId")
    AND ("parentPageId" IS NULL OR
      (length("parentPageId") BETWEEN 1 AND 64 AND "parentPageId" = btrim("parentPageId")))
    AND char_length("title") BETWEEN 1 AND 200
  )
);

CREATE UNIQUE INDEX "DocumentPublicationPageCreateIntent_publicationId_claimedAt_key"
  ON "DocumentPublicationPageCreateIntent"("publicationId", "claimedAt");
CREATE INDEX "DocumentPublicationPageCreateIntent_organisationId_documentId_idx"
  ON "DocumentPublicationPageCreateIntent"("organisationId", "documentId");
CREATE INDEX "DocumentPublicationPageCreateIntent_cloudId_spaceId_idx"
  ON "DocumentPublicationPageCreateIntent"("cloudId", "spaceId");

-- A page-create request is non-idempotent. Keep its exact intended target
-- even when the publication later retires or the document is removed.
CREATE FUNCTION "DocumentPublicationPageCreateIntent_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Publication page-create intent is immutable';
  END IF;
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Page-create intent organisation is unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM "DocumentPurgeClaim"
    WHERE "organisationId"=NEW."organisationId" AND "documentId"=NEW."documentId") THEN
    RAISE EXCEPTION 'Page-create intent is fenced by document purge';
  END IF;
  PERFORM 1 FROM "DocumentPublication" AS p
    JOIN "Document" AS d ON d.id=NEW."documentId"
      AND d."organisationId"=NEW."organisationId"
    JOIN "OrganisationIntegration" AS i ON i."organisationId"=NEW."organisationId"
      AND i.provider='CONFLUENCE' AND i.status='CONNECTED'
    WHERE p.id=NEW."publicationId"
      AND p."organisationId"=NEW."organisationId"
      AND p."documentId"=NEW."documentId"
      AND p.state='PENDING' AND p."processedAt" IS NULL
      AND p."terminalReason" IS NULL AND p."claimedAt"=NEW."claimedAt"
      AND p."remoteWriteStartedAt" IS NOT NULL
      AND p."cloudId" IS NULL AND p."spaceId" IS NULL AND p."pageId" IS NULL
      AND d."updatedAt"=NEW."documentRevision"
      AND d."deletedAt" IS NULL AND d."lifecycleStatus"='CURRENT'
      AND d."externalPublicationApproved"=true
      AND d."externalPublicationSiteId"=NEW."cloudId"
      AND d."externalPublicationSpaceId"=NEW."spaceId"
      AND i.config->>'siteId'=NEW."cloudId"
      AND i."publishSpaceSiteId"=NEW."cloudId"
      AND i."publishSpaceId"=NEW."spaceId"
      AND (i."publishingModel"->>'parentPageId') IS NOT DISTINCT FROM NEW."parentPageId"
    FOR UPDATE OF p;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Page-create intent requires current claim, approval and connected target';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentPublicationPageCreateIntent_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "DocumentPublicationPageCreateIntent"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPublicationPageCreateIntent_guard_fn"();

-- An unresolved possible page must not vanish from the copy assessment at
-- the moment the primary object is claimed for purge. A known page ID can be
-- evaluated by the ordinary publication/copy disposition path instead.
CREATE FUNCTION "DocumentPurgeClaim_page_create_intent_fence_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "DocumentPublicationPageCreateIntent" AS intent
    LEFT JOIN "DocumentPublication" AS p ON p.id=intent."publicationId"
    WHERE intent."organisationId"=NEW."organisationId"
      AND intent."documentId"=NEW."documentId"
      AND p."pageId" IS NULL) THEN
    RAISE EXCEPTION 'Document purge requires reconciliation of possible Confluence page';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentPurgeClaim_page_create_intent_fence"
  BEFORE INSERT ON "DocumentPurgeClaim"
  FOR EACH ROW EXECUTE FUNCTION "DocumentPurgeClaim_page_create_intent_fence_fn"();

COMMIT;
