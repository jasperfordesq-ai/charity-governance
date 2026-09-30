-- A charity's declared Confluence plan/residency can be reasserted or cleared.
-- Add the event in its own migration so a later CHECK can name the committed
-- enum value on both fresh and upgraded PostgreSQL databases.
ALTER TYPE "SecurityAuditEventType" ADD VALUE 'INTEGRATION_ENVIRONMENT_DECLARED';
