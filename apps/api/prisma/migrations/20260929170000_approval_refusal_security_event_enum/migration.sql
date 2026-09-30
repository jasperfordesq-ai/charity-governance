-- Commit the enum value before a later migration names it in a CHECK.
ALTER TYPE "SecurityAuditEventType" ADD VALUE 'ACTION_APPROVAL_REFUSED';
