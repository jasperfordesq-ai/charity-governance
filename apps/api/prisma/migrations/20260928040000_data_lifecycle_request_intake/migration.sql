CREATE TYPE "DataLifecycleRequestKind" AS ENUM ('ERASURE', 'RETENTION_REVIEW');
CREATE TYPE "DataLifecycleScope" AS ENUM ('ACCOUNT', 'GOVERNANCE', 'DOCUMENT', 'INTEGRATION', 'ORGANISATION', 'OTHER');
CREATE TYPE "DataLifecycleReviewState" AS ENUM ('OPEN', 'ASSESSING', 'DECISION_REQUIRED');

CREATE TABLE "DataLifecycleRequest" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "caseReference" TEXT NOT NULL,
  "kind" "DataLifecycleRequestKind" NOT NULL,
  "scope" "DataLifecycleScope" NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "reviewState" "DataLifecycleReviewState" NOT NULL DEFAULT 'OPEN',
  "enteredById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DataLifecycleRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DataLifecycleRequest_caseReference_valid" CHECK ("caseReference" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$')
);
CREATE UNIQUE INDEX "DataLifecycleRequest_organisationId_caseReference_key"
  ON "DataLifecycleRequest"("organisationId", "caseReference");
CREATE UNIQUE INDEX "DataLifecycleRequest_id_organisationId_key"
  ON "DataLifecycleRequest"("id", "organisationId");
CREATE INDEX "DataLifecycleRequest_organisationId_reviewState_receivedAt_idx"
  ON "DataLifecycleRequest"("organisationId", "reviewState", "receivedAt");

CREATE FUNCTION "DataLifecycleRequest_protect_intake_fn"() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW."id", NEW."organisationId", NEW."caseReference", NEW."kind", NEW."scope", NEW."receivedAt", NEW."enteredById", NEW."createdAt")
    IS DISTINCT FROM
     ROW(OLD."id", OLD."organisationId", OLD."caseReference", OLD."kind", OLD."scope", OLD."receivedAt", OLD."enteredById", OLD."createdAt") THEN
    RAISE EXCEPTION 'Data lifecycle intake facts are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataLifecycleRequest_protect_intake" BEFORE UPDATE ON "DataLifecycleRequest"
  FOR EACH ROW EXECUTE FUNCTION "DataLifecycleRequest_protect_intake_fn"();

CREATE TABLE "DataLifecycleReviewEvent" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "previousState" "DataLifecycleReviewState",
  "nextState" "DataLifecycleReviewState" NOT NULL,
  "reason" TEXT NOT NULL,
  "evidenceRef" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataLifecycleReviewEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DataLifecycleReviewEvent_requestId_organisationId_fkey" FOREIGN KEY ("requestId", "organisationId")
    REFERENCES "DataLifecycleRequest"("id", "organisationId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DataLifecycleReviewEvent_reason_valid" CHECK (char_length("reason") BETWEEN 10 AND 500),
  CONSTRAINT "DataLifecycleReviewEvent_evidenceRef_valid" CHECK (
    "evidenceRef" IS NULL OR "evidenceRef" ~ '^[A-Z0-9][A-Z0-9-]{2,119}$'
  )
);
CREATE INDEX "DataLifecycleReviewEvent_organisationId_requestId_occurredAt_idx"
  ON "DataLifecycleReviewEvent"("organisationId", "requestId", "occurredAt");

CREATE FUNCTION "DataLifecycleReviewEvent_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Data lifecycle review history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DataLifecycleReviewEvent_append_only" BEFORE UPDATE OR DELETE ON "DataLifecycleReviewEvent"
  FOR EACH ROW EXECUTE FUNCTION "DataLifecycleReviewEvent_append_only_fn"();
