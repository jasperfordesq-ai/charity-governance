-- Deduplicate currently open invites before adding the durable active-invite guard.
WITH ranked_open_invites AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "organisationId", "email"
            ORDER BY "createdAt" ASC, "id" ASC
        ) AS rank
    FROM "TeamInvite"
    WHERE "acceptedAt" IS NULL
      AND "revokedAt" IS NULL
)
UPDATE "TeamInvite"
SET "revokedAt" = CURRENT_TIMESTAMP,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (
    SELECT "id"
    FROM ranked_open_invites
    WHERE rank > 1
);

CREATE UNIQUE INDEX "TeamInvite_active_email_unique"
    ON "TeamInvite"("organisationId", "email")
    WHERE "acceptedAt" IS NULL
      AND "revokedAt" IS NULL;
