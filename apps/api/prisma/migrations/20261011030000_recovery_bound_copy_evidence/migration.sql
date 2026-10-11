BEGIN;
-- Under recovery enforcement, copy observations and copy authorities were
-- frozen because they could not be replayed independently. They are now
-- accepted once the authorization's primary file has its reconciled
-- completion. The whole-case disposal outcome then publishes, in full, the
-- evidence the case closed on, so what the independent record relies on is
-- replayable. Evidence written but not yet relied on may be lost on a restore
-- without harm: the case reads as incomplete and is reviewed again.
--
-- Copy holds stay frozen. A lost hold would fail open (a copy someone chose
-- to preserve treated as disposable), so holds need their own independently
-- published entry first. The existing per-table guards (owner, plan,
-- authority, revision and time checks) still run after this gate.
CREATE FUNCTION "DocumentCopyEvidence_recovery_gate_fn"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "Organisation" WHERE id=NEW."organisationId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "DocumentRecoveryEnforcement"
    WHERE "organisationId"=NEW."organisationId")
    AND NOT EXISTS (SELECT 1 FROM "DocumentPurgeClaim" claim
      JOIN "DocumentBytePrimaryCompletion" completion
        ON completion."deletionId"=claim."deletionId"
        AND completion."organisationId"=claim."organisationId"
      WHERE claim."authorizationId"=NEW."authorizationId"
        AND claim."organisationId"=NEW."organisationId") THEN
    RAISE EXCEPTION 'Document copy change requires independent recovery authority';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "A_DocumentCopyAuthority_recovery_gate" ON "DocumentCopyDispositionAuthority";
CREATE TRIGGER "A_DocumentCopyAuthority_recovery_gate"
  BEFORE INSERT ON "DocumentCopyDispositionAuthority"
  FOR EACH ROW EXECUTE FUNCTION "DocumentCopyEvidence_recovery_gate_fn"();
DROP TRIGGER "A_DocumentCopyObservation_recovery_gate" ON "DocumentPurgeDispositionEvent";
CREATE TRIGGER "A_DocumentCopyObservation_recovery_gate"
  BEFORE INSERT ON "DocumentPurgeDispositionEvent"
  FOR EACH ROW EXECUTE FUNCTION "DocumentCopyEvidence_recovery_gate_fn"();
COMMIT;
