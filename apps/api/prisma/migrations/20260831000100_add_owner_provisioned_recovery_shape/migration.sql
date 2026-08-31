-- PasswordRecoveryRequest_source_shape_check enumerates the exact allowed
-- column shape per PasswordRecoverySource. The OWNER_PROVISIONED source added
-- in the previous migration had no branch here, so every insert using it
-- failed this check regardless of shape. Add a branch matching how
-- owner-provisioning.service.ts actually writes the row: delivered
-- immediately (ACCEPTED, no rate-limit/evidence columns, matching
-- PERSONAL_SERVER_OPERATOR's shape), but — unlike PERSONAL_SERVER_OPERATOR,
-- which never emails and leaves these null — with recipientEmail,
-- recipientName, and deliveryTemplateVersion populated, since this source
-- does send a real email and those columns document what was sent.
ALTER TABLE "PasswordRecoveryRequest"
    DROP CONSTRAINT "PasswordRecoveryRequest_source_shape_check";

ALTER TABLE "PasswordRecoveryRequest"
    ADD CONSTRAINT "PasswordRecoveryRequest_source_shape_check" CHECK (
        (
            "source" = 'SELF_SERVICE_EMAIL'::"PasswordRecoverySource"
            AND (
                (
                    "requestEvidenceRedactedAt" IS NULL
                    AND "identifierDigest" IS NOT NULL
                    AND "requestIpDigest" IS NOT NULL
                    AND "requestNetworkDigest" IS NOT NULL
                    AND "rateKeyVersion" IS NOT NULL
                )
                OR (
                    "requestEvidenceRedactedAt" IS NOT NULL
                    AND "identifierDigest" IS NULL
                    AND "requestIpDigest" IS NULL
                    AND "requestNetworkDigest" IS NULL
                    AND "rateKeyVersion" IS NULL
                )
            )
            AND (
                "deliveryState" = 'SUPPRESSED'::"PasswordRecoveryDeliveryState"
                OR (
                    "tokenNonce" IS NOT NULL
                    AND "tokenKeyVersion" IS NOT NULL
                    AND "recipientEmail" IS NOT NULL
                    AND "recipientName" IS NOT NULL
                    AND "frontendOrigin" IS NOT NULL
                    AND "deliveryTemplateVersion" = 1
                )
            )
        )
        OR
        (
            "source" = 'LEGACY_USER_SLOT'::"PasswordRecoverySource"
            AND "deliveryState" = 'UNCERTAIN'::"PasswordRecoveryDeliveryState"
            AND "identifierDigest" IS NULL
            AND "requestIpDigest" IS NULL
            AND "requestNetworkDigest" IS NULL
            AND "rateKeyVersion" IS NULL
            AND "requestEvidenceRedactedAt" IS NULL
            AND "tokenNonce" IS NULL
            AND "tokenKeyVersion" IS NULL
            AND "deliveryTemplateVersion" IS NULL
        )
        OR
        (
            "source" = 'PERSONAL_SERVER_OPERATOR'::"PasswordRecoverySource"
            AND "deliveryState" = 'ACCEPTED'::"PasswordRecoveryDeliveryState"
            AND "identifierDigest" IS NULL
            AND "requestIpDigest" IS NULL
            AND "requestNetworkDigest" IS NULL
            AND "rateKeyVersion" IS NULL
            AND "requestEvidenceRedactedAt" IS NULL
            AND "deliveryTemplateVersion" IS NULL
        )
        OR
        (
            "source" = 'OWNER_PROVISIONED'::"PasswordRecoverySource"
            AND "deliveryState" = 'ACCEPTED'::"PasswordRecoveryDeliveryState"
            AND "identifierDigest" IS NULL
            AND "requestIpDigest" IS NULL
            AND "requestNetworkDigest" IS NULL
            AND "rateKeyVersion" IS NULL
            AND "requestEvidenceRedactedAt" IS NULL
            AND "recipientEmail" IS NOT NULL
            AND "recipientName" IS NOT NULL
            AND "deliveryTemplateVersion" = 1
        )
    );
