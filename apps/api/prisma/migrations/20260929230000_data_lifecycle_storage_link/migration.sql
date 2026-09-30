-- Bind an unresolved data request to a retained storage-deletion job without
-- turning that job's technical outcome into an erasure disposition.
CREATE UNIQUE INDEX "DocumentStorageDeletion_id_organisationId_key"
  ON "DocumentStorageDeletion"("id", "organisationId");

CREATE TABLE "DataLifecycleStorageLink" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "deletionId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataLifecycleStorageLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DataLifecycleStorageLink_reason_valid" CHECK (char_length("reason") BETWEEN 10 AND 500),
  CONSTRAINT "DataLifecycleStorageLink_requestId_organisationId_fkey"
    FOREIGN KEY ("requestId", "organisationId")
    REFERENCES "DataLifecycleRequest"("id", "organisationId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DataLifecycleStorageLink_deletionId_organisationId_fkey"
    FOREIGN KEY ("deletionId", "organisationId")
    REFERENCES "DocumentStorageDeletion"("id", "organisationId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DataLifecycleStorageLink_requestId_deletionId_key"
  ON "DataLifecycleStorageLink"("requestId", "deletionId");
CREATE UNIQUE INDEX "DataLifecycleStorageLink_id_organisationId_requestId_key"
  ON "DataLifecycleStorageLink"("id", "organisationId", "requestId");
CREATE INDEX "DataLifecycleStorageLink_organisationId_requestId_createdAt_id_idx"
  ON "DataLifecycleStorageLink"("organisationId", "requestId", "createdAt", "id");

CREATE TABLE "DataLifecycleStorageLinkWithdrawal" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "linkId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataLifecycleStorageLinkWithdrawal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DataLifecycleStorageLinkWithdrawal_reason_valid" CHECK (char_length("reason") BETWEEN 10 AND 500),
  CONSTRAINT "DataLifecycleStorageLinkWithdrawal_linkId_organisationId_requestId_fkey"
    FOREIGN KEY ("linkId", "organisationId", "requestId")
    REFERENCES "DataLifecycleStorageLink"("id", "organisationId", "requestId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DataLifecycleStorageLinkWithdrawal_linkId_key"
  ON "DataLifecycleStorageLinkWithdrawal"("linkId");
CREATE UNIQUE INDEX "DataLifecycleStorageLinkWithdrawal_linkId_organisationId_requestId_key"
  ON "DataLifecycleStorageLinkWithdrawal"("linkId", "organisationId", "requestId");

CREATE FUNCTION "DataLifecycleStorageLink_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Data lifecycle storage links are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataLifecycleStorageLink_append_only"
  BEFORE UPDATE OR DELETE ON "DataLifecycleStorageLink"
  FOR EACH ROW EXECUTE FUNCTION "DataLifecycleStorageLink_append_only_fn"();

CREATE FUNCTION "DataLifecycleStorageLinkWithdrawal_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Data lifecycle storage-link withdrawals are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataLifecycleStorageLinkWithdrawal_append_only"
  BEFORE UPDATE OR DELETE ON "DataLifecycleStorageLinkWithdrawal"
  FOR EACH ROW EXECUTE FUNCTION "DataLifecycleStorageLinkWithdrawal_append_only_fn"();
