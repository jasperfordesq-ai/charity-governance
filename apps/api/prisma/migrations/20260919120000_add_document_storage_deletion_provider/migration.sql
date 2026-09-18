-- Provider-aware erasure (Phase 5, Task 1).
--
-- A deletion row can now name the provider that owns the bytes and, for
-- providers that are not addressed by a Supabase object path, the reference
-- the eraser needs. "storagePath" keeps its exact prior meaning: it is the
-- Supabase object path, and it is meaningful only for rows whose provider
-- actually uses it. Nothing here backfills or reinterprets it.
--
-- Purely additive: every existing row takes the 'supabase' default, so there is
-- no backfill and no lock beyond the column add.
BEGIN;

ALTER TABLE "DocumentStorageDeletion"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'supabase',
  ADD COLUMN "targetRef" JSONB;

CREATE INDEX "DocumentStorageDeletion_provider_state_nextAttemptAt_idx"
  ON "DocumentStorageDeletion"("provider", "state", "nextAttemptAt");

COMMIT;
