-- Existing rows must be classified and reconciled with the controller before
-- validation. NOT VALID still blocks every new or updated unreviewed release.
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_member_visibility_requires_review"
  CHECK (
    "visibility" <> 'MEMBER_VISIBLE'::"DocumentVisibility"
    OR "lifecycleStatus" <> 'UNREVIEWED'::"DocumentLifecycleStatus"
  ) NOT VALID;
