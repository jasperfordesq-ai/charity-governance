-- A reviewer may associate an unresolved case with an exact live Vault record.
-- The opaque document ID survives ordinary draft removal, without keeping a
-- foreign key that would prevent deletion or copying document content here.
CREATE TABLE "DataLifecycleDocumentLink" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataLifecycleDocumentLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DataLifecycleDocumentLink_reason_valid" CHECK (char_length("reason") BETWEEN 10 AND 500),
  CONSTRAINT "DataLifecycleDocumentLink_requestId_organisationId_fkey"
    FOREIGN KEY ("requestId", "organisationId")
    REFERENCES "DataLifecycleRequest"("id", "organisationId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DataLifecycleDocumentLink_requestId_documentId_key"
  ON "DataLifecycleDocumentLink"("requestId", "documentId");
CREATE UNIQUE INDEX "DataLifecycleDocumentLink_id_organisationId_requestId_key"
  ON "DataLifecycleDocumentLink"("id", "organisationId", "requestId");
CREATE INDEX "DataLifecycleDocumentLink_organisationId_requestId_createdAt_id_idx"
  ON "DataLifecycleDocumentLink"("organisationId", "requestId", "createdAt", "id");

CREATE TABLE "DataLifecycleDocumentLinkWithdrawal" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "linkId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataLifecycleDocumentLinkWithdrawal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DataLifecycleDocumentLinkWithdrawal_reason_valid" CHECK (char_length("reason") BETWEEN 10 AND 500),
  CONSTRAINT "DataLifecycleDocumentLinkWithdrawal_linkId_organisationId_requestId_fkey"
    FOREIGN KEY ("linkId", "organisationId", "requestId")
    REFERENCES "DataLifecycleDocumentLink"("id", "organisationId", "requestId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DataLifecycleDocumentLinkWithdrawal_linkId_key"
  ON "DataLifecycleDocumentLinkWithdrawal"("linkId");
CREATE UNIQUE INDEX "DataLifecycleDocumentLinkWithdrawal_linkId_organisationId_requestId_key"
  ON "DataLifecycleDocumentLinkWithdrawal"("linkId", "organisationId", "requestId");

CREATE FUNCTION "guard_data_lifecycle_document_link"() RETURNS trigger AS $$
BEGIN
  -- The row lock serialises this check with ordinary document removal. A
  -- historical link does not retain a foreign key to the removed document.
  PERFORM 1 FROM "Document"
    WHERE "id" = NEW."documentId" AND "organisationId" = NEW."organisationId"
    FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Data lifecycle link requires a live document in the same charity'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataLifecycleDocumentLink_source_guard"
  BEFORE INSERT ON "DataLifecycleDocumentLink"
  FOR EACH ROW EXECUTE FUNCTION "guard_data_lifecycle_document_link"();

CREATE FUNCTION "DataLifecycleDocumentLink_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Data lifecycle document links are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataLifecycleDocumentLink_append_only"
  BEFORE UPDATE OR DELETE ON "DataLifecycleDocumentLink"
  FOR EACH ROW EXECUTE FUNCTION "DataLifecycleDocumentLink_append_only_fn"();

CREATE FUNCTION "DataLifecycleDocumentLinkWithdrawal_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Data lifecycle document-link withdrawals are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataLifecycleDocumentLinkWithdrawal_append_only"
  BEFORE UPDATE OR DELETE ON "DataLifecycleDocumentLinkWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "DataLifecycleDocumentLinkWithdrawal_append_only_fn"();
