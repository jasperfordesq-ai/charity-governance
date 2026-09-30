-- Existing DRAFT/MEMBER_VISIBLE rows need a controller review before this
-- constraint can be validated. NOT VALID still rejects new or updated rows.
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_member_visibility_excludes_draft"
  CHECK (
    "visibility" <> 'MEMBER_VISIBLE'::"DocumentVisibility"
    OR "lifecycleStatus" <> 'DRAFT'::"DocumentLifecycleStatus"
  ) NOT VALID;
