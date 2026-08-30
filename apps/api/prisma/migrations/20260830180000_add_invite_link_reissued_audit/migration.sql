-- Reissuing a personal-server invitation link mints a fresh bearer credential
-- for the same invite. That is a security-relevant act, so it needs its own
-- audit type rather than being folded into INVITE_REVOKED or left unrecorded.
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PostgreSQL 12+
-- provided the new value is not used in the same transaction; this migration
-- only declares it.
ALTER TYPE "SecurityAuditEventType" ADD VALUE IF NOT EXISTS 'INVITE_LINK_REISSUED';
