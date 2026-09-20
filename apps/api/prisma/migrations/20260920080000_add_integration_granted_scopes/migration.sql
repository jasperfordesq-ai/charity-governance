-- Atlassian's v2 delete endpoints require delete:page:confluence and
-- delete:attachment:confluence, which CharityPilot never requested. Adding them
-- to the authorize URL is not enough on its own: a tenant that authorised
-- before the change keeps a perfectly good connection that will 403 on an
-- erasure, and a 403 from Confluence is reported as CONFLUENCE_RECONNECT_REQUIRED
-- — which sends an operator to fix the wrong thing. Recording what was granted
-- is what lets the erasure workflow refuse up front, naming the real remedy.
--
-- An existing row gets the empty array, which reads as "unknown, so not
-- granted": those tenants must reconnect before they can erase. Nobody is
-- forced to reconnect for anything else.
ALTER TABLE "OrganisationIntegration"
    ADD COLUMN "grantedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
