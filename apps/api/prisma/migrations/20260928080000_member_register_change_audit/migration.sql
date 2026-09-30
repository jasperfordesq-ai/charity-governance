-- Extend the metadata-only register trail to the statutory membership register.
-- Names and addresses remain solely in the live register, not its action log.
BEGIN;
ALTER TABLE "GovernanceRegisterChangeAudit"
  DROP CONSTRAINT "GovernanceRegisterChangeAudit_kind_valid";
ALTER TABLE "GovernanceRegisterChangeAudit"
  ADD CONSTRAINT "GovernanceRegisterChangeAudit_kind_valid" CHECK (
    "recordKind" IN ('TRUSTEE', 'CONFLICT', 'COMPLAINT', 'FUNDRAISING',
      'ANNUAL_REPORT', 'FINANCIAL_CONTROL', 'MEMBER')
  );
COMMIT;
