-- Sibling guard to DocumentStorageDeletion_alert_claim_consistent: keep the
-- refresh claim fail-closed even when an application regression bypasses the
-- normal service methods. refreshClaimToken and refreshClaimedAt must move in
-- lockstep -- token present if and only if claimed -- so a bug that clears
-- one column without the other cannot corrupt the claim state silently.
--
-- Every existing row has both columns NULL, so this is additive and safe
-- against current data.
ALTER TABLE "OrganisationIntegration"
    ADD CONSTRAINT "OrganisationIntegration_refresh_claim_consistent"
        CHECK (("refreshClaimToken" IS NULL) = ("refreshClaimedAt" IS NULL));
