-- Keep a structural, tenant-bound successor for future supersession decisions.
-- Previously classified SUPERSEDED rows may have no successor: they need
-- individual review, and this migration must not invent or rewrite one.
ALTER TABLE "Document" ADD COLUMN "supersededByDocumentId" TEXT;
CREATE UNIQUE INDEX "Document_id_organisationId_key" ON "Document"("id", "organisationId");
CREATE INDEX "Document_organisationId_supersededByDocumentId_idx"
    ON "Document"("organisationId", "supersededByDocumentId");
ALTER TABLE "Document" ADD CONSTRAINT "Document_supersededByDocumentId_organisationId_fkey"
    FOREIGN KEY ("supersededByDocumentId", "organisationId")
    REFERENCES "Document"("id", "organisationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Document" ADD CONSTRAINT "Document_replacement_requires_historical_lifecycle"
    CHECK ("supersededByDocumentId" IS NULL OR "lifecycleStatus" IN ('SUPERSEDED', 'HISTORICAL'));
ALTER TABLE "Document" ADD CONSTRAINT "Document_cannot_replace_itself"
    CHECK ("supersededByDocumentId" IS NULL OR "supersededByDocumentId" <> "id");

-- Preserve category agreement after the replacement is selected. The row
-- lock on the successor serialises a concurrent replacement link against a
-- category edit of that same successor.
CREATE FUNCTION "Document_replacement_category_fn"() RETURNS trigger AS $$
DECLARE
    successor_category "DocumentCategory";
BEGIN
    IF NEW."supersededByDocumentId" IS NOT NULL THEN
        SELECT "category" INTO successor_category
        FROM "Document"
        WHERE "id" = NEW."supersededByDocumentId"
          AND "organisationId" = NEW."organisationId"
        FOR SHARE;
        IF FOUND AND successor_category <> NEW."category" THEN
            RAISE EXCEPTION 'Document replacement category mismatch' USING ERRCODE = '23514';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW."category" IS DISTINCT FROM OLD."category" THEN
            IF EXISTS (
                SELECT 1 FROM "Document"
                WHERE "organisationId" = NEW."organisationId"
                  AND "supersededByDocumentId" = NEW."id"
            ) THEN
                RAISE EXCEPTION 'Referenced replacement category cannot change' USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Document_replacement_category" BEFORE INSERT OR UPDATE OF "supersededByDocumentId", "category" ON "Document"
    FOR EACH ROW EXECUTE FUNCTION "Document_replacement_category_fn"();
