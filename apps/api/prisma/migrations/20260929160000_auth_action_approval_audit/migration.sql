BEGIN;

CREATE TYPE "AuthActionApprovalAuditKind" AS ENUM ('REQUESTED', 'RENEWED', 'GRANTED', 'CONSUMED');

CREATE TABLE "AuthActionApprovalAudit" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "approvalId" TEXT NOT NULL,
  "kind" "AuthActionApprovalAuditKind" NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "routePattern" TEXT NOT NULL,
  "resourceId" TEXT,
  "expiresAt" TIMESTAMP(3),
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "backfilled" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "AuthActionApprovalAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuthActionApprovalAudit_organisationId_occurredAt_id_idx"
  ON "AuthActionApprovalAudit"("organisationId", "occurredAt", "id");
CREATE INDEX "AuthActionApprovalAudit_approvalId_occurredAt_id_idx"
  ON "AuthActionApprovalAudit"("approvalId", "occurredAt", "id");
ALTER TABLE "AuthActionApprovalAudit"
  ADD CONSTRAINT "AuthActionApprovalAudit_approvalId_organisationId_fkey"
  FOREIGN KEY ("approvalId", "organisationId")
  REFERENCES "AuthActionApproval"("id", "organisationId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hold approval writes through the backfill and trigger installation. A grant
-- racing the migration must be either in the backfill or captured afterward.
LOCK TABLE "AuthActionApproval" IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO "AuthActionApprovalAudit"
  ("id", "organisationId", "approvalId", "kind", "actorUserId", "method", "routePattern", "resourceId", "expiresAt", "occurredAt", "backfilled")
SELECT gen_random_uuid()::text, "organisationId", "id", 'REQUESTED', "userId", "method", "routePattern", "resourceId", NULL, "createdAt", true
FROM "AuthActionApproval";
INSERT INTO "AuthActionApprovalAudit"
  ("id", "organisationId", "approvalId", "kind", "actorUserId", "method", "routePattern", "resourceId", "expiresAt", "occurredAt", "backfilled")
SELECT gen_random_uuid()::text, "organisationId", "id", 'GRANTED', "userId", "method", "routePattern", "resourceId", NULL, "approvedAt", true
FROM "AuthActionApproval" WHERE "approvedAt" IS NOT NULL;
INSERT INTO "AuthActionApprovalAudit"
  ("id", "organisationId", "approvalId", "kind", "actorUserId", "method", "routePattern", "resourceId", "expiresAt", "occurredAt", "backfilled")
SELECT gen_random_uuid()::text, "organisationId", "id", 'CONSUMED', "userId", "method", "routePattern", "resourceId", NULL, "consumedAt", true
FROM "AuthActionApproval" WHERE "consumedAt" IS NOT NULL;

-- Protect the capability's identity and monotone lifecycle. Pending requests
-- may renew their five-minute expiry and server-built summary; grants may not.
CREATE FUNCTION "AuthActionApproval_audit_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."approvedAt" IS NOT NULL OR NEW."consumedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'New approval must start unapproved and unspent';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organisationId" IS DISTINCT FROM OLD."organisationId"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."sessionFamilyId" IS DISTINCT FROM OLD."sessionFamilyId"
    OR NEW."requestDigest" IS DISTINCT FROM OLD."requestDigest"
    OR NEW."method" IS DISTINCT FROM OLD."method"
    OR NEW."routePattern" IS DISTINCT FROM OLD."routePattern"
    OR NEW."resourceId" IS DISTINCT FROM OLD."resourceId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Approval identity is immutable';
  END IF;
  IF OLD."approvedAt" IS NOT NULL AND NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" THEN
    RAISE EXCEPTION 'Approval grant cannot be rewritten';
  END IF;
  IF OLD."consumedAt" IS NOT NULL AND NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt" THEN
    RAISE EXCEPTION 'Approval consumption cannot be rewritten';
  END IF;
  IF OLD."approvedAt" IS NOT NULL AND
    (NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."summary" IS DISTINCT FROM OLD."summary") THEN
    RAISE EXCEPTION 'Granted approval cannot be renewed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AuthActionApproval_audit_guard"
  BEFORE INSERT OR UPDATE ON "AuthActionApproval"
  FOR EACH ROW EXECUTE FUNCTION "AuthActionApproval_audit_guard_fn"();

CREATE FUNCTION "AuthActionApproval_audit_capture_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "AuthActionApprovalAudit"
      ("id", "organisationId", "approvalId", "kind", "actorUserId", "method", "routePattern", "resourceId", "expiresAt", "occurredAt")
    VALUES (gen_random_uuid()::text, NEW."organisationId", NEW."id", 'REQUESTED', NEW."userId", NEW."method", NEW."routePattern", NEW."resourceId", NEW."expiresAt", NEW."createdAt");
  ELSE
    IF NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" AND OLD."approvedAt" IS NULL THEN
      INSERT INTO "AuthActionApprovalAudit"
        ("id", "organisationId", "approvalId", "kind", "actorUserId", "method", "routePattern", "resourceId", "expiresAt")
      VALUES (gen_random_uuid()::text, NEW."organisationId", NEW."id", 'RENEWED', NEW."userId", NEW."method", NEW."routePattern", NEW."resourceId", NEW."expiresAt");
    END IF;
    IF OLD."approvedAt" IS NULL AND NEW."approvedAt" IS NOT NULL THEN
      INSERT INTO "AuthActionApprovalAudit"
        ("id", "organisationId", "approvalId", "kind", "actorUserId", "method", "routePattern", "resourceId", "expiresAt", "occurredAt")
      VALUES (gen_random_uuid()::text, NEW."organisationId", NEW."id", 'GRANTED', NEW."userId", NEW."method", NEW."routePattern", NEW."resourceId", NEW."expiresAt", NEW."approvedAt");
    END IF;
    IF OLD."consumedAt" IS NULL AND NEW."consumedAt" IS NOT NULL THEN
      INSERT INTO "AuthActionApprovalAudit"
        ("id", "organisationId", "approvalId", "kind", "actorUserId", "method", "routePattern", "resourceId", "expiresAt", "occurredAt")
      VALUES (gen_random_uuid()::text, NEW."organisationId", NEW."id", 'CONSUMED', NEW."userId", NEW."method", NEW."routePattern", NEW."resourceId", NEW."expiresAt", NEW."consumedAt");
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AuthActionApproval_audit_capture"
  AFTER INSERT OR UPDATE ON "AuthActionApproval"
  FOR EACH ROW EXECUTE FUNCTION "AuthActionApproval_audit_capture_fn"();

CREATE FUNCTION "AuthActionApprovalAudit_append_only_fn"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Approval action history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AuthActionApprovalAudit_append_only"
  BEFORE UPDATE OR DELETE ON "AuthActionApprovalAudit"
  FOR EACH ROW EXECUTE FUNCTION "AuthActionApprovalAudit_append_only_fn"();

COMMIT;
