-- PasswordRecoveryRequest_timeline_check's per-source clause only recognized
-- SELF_SERVICE_EMAIL plus the two-member list (LEGACY_USER_SLOT,
-- PERSONAL_SERVER_OPERATOR); OWNER_PROVISIONED matched neither branch, so the
-- clause was unconditionally false and every OWNER_PROVISIONED insert failed
-- this check regardless of its claimedAt/deliveryAttemptedAt values. Add it to
-- the same list as PERSONAL_SERVER_OPERATOR: owner-provisioning.service.ts
-- writes claimedAt and deliveryAttemptedAt as NULL for this source too (the
-- row is delivered synchronously, not claimed by the async delivery worker).
ALTER TABLE "PasswordRecoveryRequest"
    DROP CONSTRAINT "PasswordRecoveryRequest_timeline_check";

ALTER TABLE "PasswordRecoveryRequest"
    ADD CONSTRAINT "PasswordRecoveryRequest_timeline_check" CHECK (
        ("expiresAt" IS NULL OR (
            "expiresAt" > "createdAt"
            AND "expiresAt" <= "createdAt" + INTERVAL '1 hour'
        ))
        AND ("claimedAt" IS NULL OR "claimedAt" >= "createdAt")
        AND ("deliveryFinalizedAt" IS NULL OR "deliveryFinalizedAt" >= "createdAt")
        AND ("terminatedAt" IS NULL OR "terminatedAt" >= "createdAt")
        AND "evidenceRetentionAnchorAt" >= "createdAt"
        AND (
            "requestEvidenceRedactedAt" IS NULL
            OR "requestEvidenceRedactedAt" >= "createdAt"
        )
        AND (
            (
                "source" = 'SELF_SERVICE_EMAIL'::"PasswordRecoverySource"
                AND (
                    "deliveryAttemptedAt" IS NULL
                    OR (
                        "claimedAt" IS NOT NULL
                        AND "deliveryAttemptedAt" >= "claimedAt"
                    )
                )
                AND (
                    "deliveryFinalizedAt" IS NULL
                    OR (
                        "deliveryAttemptedAt" IS NOT NULL
                        AND "deliveryFinalizedAt" >= "deliveryAttemptedAt"
                    )
                )
            )
            OR
            (
                "source" IN (
                    'LEGACY_USER_SLOT'::"PasswordRecoverySource",
                    'PERSONAL_SERVER_OPERATOR'::"PasswordRecoverySource",
                    'OWNER_PROVISIONED'::"PasswordRecoverySource"
                )
                AND "claimedAt" IS NULL
                AND "deliveryAttemptedAt" IS NULL
            )
        )
    );
