-- Keep a reviewable actor and revision trail without duplicating the charity's
-- profile values, which can contain trustees' home and contact details.
CREATE TABLE "OrganisationChangeAudit" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "submittedFields" TEXT[] NOT NULL,
  "previousUpdatedAt" TIMESTAMP(3) NOT NULL,
  "nextUpdatedAt" TIMESTAMP(3) NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganisationChangeAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrganisationChangeAudit_actor_required" CHECK (length("actorUserId") > 0),
  CONSTRAINT "OrganisationChangeAudit_fields_required" CHECK (cardinality("submittedFields") > 0)
);

CREATE INDEX "OrganisationChangeAudit_organisationId_occurredAt_idx"
  ON "OrganisationChangeAudit"("organisationId", "occurredAt");

CREATE FUNCTION "OrganisationChangeAudit_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Organisation change history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "OrganisationChangeAudit_append_only" BEFORE UPDATE OR DELETE ON "OrganisationChangeAudit"
  FOR EACH ROW EXECUTE FUNCTION "OrganisationChangeAudit_append_only_fn"();
