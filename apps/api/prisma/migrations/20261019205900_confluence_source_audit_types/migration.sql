-- Commit enum additions before the following migration uses them in a CHECK.
ALTER TYPE "SecurityAuditEventType" ADD VALUE 'CONFLUENCE_SOURCE_REGISTERED';
ALTER TYPE "SecurityAuditEventType" ADD VALUE 'CONFLUENCE_SOURCE_REMOVED';
