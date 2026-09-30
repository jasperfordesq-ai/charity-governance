-- Narrow, online lookup for new source-labelled deletion jobs. Legacy NULL
-- rows are omitted; their source identities are deliberately not inferred.
CREATE INDEX CONCURRENTLY "DocumentStorageDeletion_source_lookup_idx"
  ON "DocumentStorageDeletion" ("organisationId", "sourceDocumentId", "createdAt" DESC, "id" DESC)
  WHERE "sourceDocumentId" IS NOT NULL;
