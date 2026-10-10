-- Minimal, time-bounded session request trace for attributing future
-- SESSION_REPLAY_DETECTED events. Written only when
-- SESSION_SECURITY_TRACE_RETENTION_DAYS is configured; the period is a
-- data-protection decision. No user, charity, session or token value: a
-- one-way token fingerprint, a network prefix and a user-agent digest only.
CREATE TABLE "SessionSecurityTrace" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "routePattern" TEXT NOT NULL CHECK (char_length("routePattern") BETWEEN 1 AND 120),
  "statusCode" INTEGER NOT NULL CHECK ("statusCode" BETWEEN 100 AND 599),
  "requestId" TEXT CHECK ("requestId" IS NULL OR char_length("requestId") BETWEEN 1 AND 128),
  "presentedTokenFingerprint" TEXT CHECK ("presentedTokenFingerprint" IS NULL
    OR "presentedTokenFingerprint" ~ '^[a-f0-9]{16}$'),
  "networkPrefix" TEXT CHECK ("networkPrefix" IS NULL OR char_length("networkPrefix") BETWEEN 1 AND 64),
  "userAgentDigest" TEXT CHECK ("userAgentDigest" IS NULL OR "userAgentDigest" ~ '^[a-f0-9]{16}$')
);
CREATE INDEX "SessionSecurityTrace_occurredAt_idx" ON "SessionSecurityTrace"("occurredAt");
CREATE INDEX "SessionSecurityTrace_presentedTokenFingerprint_idx"
  ON "SessionSecurityTrace"("presentedTokenFingerprint", "occurredAt");
CREATE INDEX "SessionSecurityTrace_requestId_idx" ON "SessionSecurityTrace"("requestId");

-- Evidence is never rewritten, and a row can be removed only by retention:
-- nothing younger than a day can be deleted.
CREATE FUNCTION "SessionSecurityTrace_guard_fn"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Session security trace rows are never rewritten';
  END IF;
  IF OLD."occurredAt" >= CURRENT_TIMESTAMP - INTERVAL '1 day' THEN
    RAISE EXCEPTION 'Session security trace rows are removed only by retention';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SessionSecurityTrace_guard"
  BEFORE UPDATE OR DELETE ON "SessionSecurityTrace"
  FOR EACH ROW EXECUTE FUNCTION "SessionSecurityTrace_guard_fn"();
