-- Revocation by the installation operator after a suspected signing-secret
-- exposure: every live charity session at once. Distinct from an
-- administrator revoking one member's sessions, so the evidence says which.
ALTER TYPE "AuthSessionRevocationReason" ADD VALUE IF NOT EXISTS 'INSTALLATION_SESSIONS_REVOKED';
