-- A Member release cannot rely on the charity's current storage preference
-- for a file whose written provider has not been established. Existing
-- violations remain for controller review and are hidden by Member queries.
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_member_visibility_requires_written_provider"
  CHECK (
    "visibility" <> 'MEMBER_VISIBLE'::"DocumentVisibility"
    OR ("storageProvider" IS NOT NULL AND "storageProvider" IN ('local', 'supabase'))
  ) NOT VALID;
