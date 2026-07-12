-- P1-07A expands the single User reset-token slot into independent, bounded,
-- tenant-bound recovery requests. Existing unexpired links are preserved as
-- legacy/uncertain evidence; no migration invents provider acceptance.

BEGIN;

LOCK TABLE "Organisation" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "AuthSession" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "SecurityAuditEvent" IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
    half_pair_count INTEGER;
    malformed_hash_count INTEGER;
    unsafe_future_expiry_count INTEGER;
    overlong_active_email_count INTEGER;
BEGIN
    SELECT COUNT(*)::INTEGER
    INTO half_pair_count
    FROM "User" AS account
    JOIN "Organisation" AS organisation
      ON organisation."id" = account."organisationId"
    WHERE (account."resetToken" IS NULL) <> (account."resetTokenExpiry" IS NULL)
      AND account."lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus"
      AND organisation."lifecycleStatus" = 'ACTIVE'::"OrganisationLifecycleStatus";

    SELECT COUNT(*)::INTEGER
    INTO malformed_hash_count
    FROM "User" AS account
    JOIN "Organisation" AS organisation
      ON organisation."id" = account."organisationId"
    WHERE account."resetToken" IS NOT NULL
      AND account."resetToken" !~ '^[0-9a-f]{64}$'
      AND account."lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus"
      AND organisation."lifecycleStatus" = 'ACTIVE'::"OrganisationLifecycleStatus";

    SELECT COUNT(*)::INTEGER
    INTO unsafe_future_expiry_count
    FROM "User" AS account
    JOIN "Organisation" AS organisation
      ON organisation."id" = account."organisationId"
    WHERE account."resetToken" IS NOT NULL
      AND account."lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus"
      AND organisation."lifecycleStatus" = 'ACTIVE'::"OrganisationLifecycleStatus"
      -- Fail closed rather than extending or silently mutating corrupt legacy
      -- credentials. Every preserved link must have no more than the new
      -- one-hour maximum lifetime remaining at migration time.
       AND account."resetTokenExpiry" > CURRENT_TIMESTAMP + INTERVAL '1 hour';

    SELECT COUNT(*)::INTEGER
    INTO overlong_active_email_count
    FROM "User" AS account
    JOIN "Organisation" AS organisation
      ON organisation."id" = account."organisationId"
    WHERE CHAR_LENGTH(account."email") > 254
      AND account."lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus"
      AND organisation."lifecycleStatus" = 'ACTIVE'::"OrganisationLifecycleStatus";

    IF half_pair_count <> 0
       OR malformed_hash_count <> 0
       OR unsafe_future_expiry_count <> 0
       OR overlong_active_email_count <> 0 THEN
        RAISE EXCEPTION
            'P1-07A password recovery migration refused: legacy_half_pairs=%, malformed_token_hashes=%, unsafe_future_expiries=%, overlong_active_emails=%',
            half_pair_count,
            malformed_hash_count,
            unsafe_future_expiry_count,
            overlong_active_email_count
            USING ERRCODE = '23514',
                  HINT = 'Keep runtimes stopped; prove this transaction left zero target catalog residue; deliberately remediate the exact active legacy reset and overlong-email User rows without inventing recovery evidence; resolve only 20260712013000_add_password_recovery_integrity as rolled back; then rerun migrate deploy and migrate status.';
    END IF;
END;
$preflight$;

CREATE TYPE "PasswordRecoverySource" AS ENUM (
    'SELF_SERVICE_EMAIL',
    'LEGACY_USER_SLOT',
    'PERSONAL_SERVER_OPERATOR'
);

CREATE TYPE "PasswordRecoveryDeliveryState" AS ENUM (
    'SUPPRESSED',
    'PENDING',
    'SENDING',
    'ACCEPTED',
    'REJECTED',
    'UNCERTAIN'
);

CREATE TYPE "PasswordRecoverySuppressionReason" AS ENUM (
    'NO_ELIGIBLE_ACCOUNT',
    'RATE_LIMITED',
    'OUTSTANDING_LIMIT'
);

CREATE TYPE "PasswordRecoveryTerminationReason" AS ENUM (
    'PASSWORD_RESET_COMPLETED',
    'DELIVERY_REJECTED',
    'KEY_UNAVAILABLE',
    'KEY_ROTATED',
    'ACCOUNT_INACTIVE',
    'EXPIRED'
);

CREATE TYPE "AuthRecoveryRateLimitScope" AS ENUM (
    'FORGOT_IDENTIFIER_15M',
    'FORGOT_IDENTIFIER_24H',
    'FORGOT_NETWORK_15M',
    'FORGOT_NETWORK_24H',
    'RESET_TOKEN_15M',
    'RESET_TOKEN_24H',
    'RESET_NETWORK_15M',
    'RESET_NETWORK_24H'
);

CREATE TYPE "AuthSecurityEmailKind" AS ENUM (
    'PASSWORD_RESET_COMPLETED_NOTICE'
);

CREATE TYPE "AuthSecurityEmailDeliveryState" AS ENUM (
    'PENDING',
    'SENDING',
    'ACCEPTED',
    'REJECTED',
    'UNCERTAIN'
);

CREATE TABLE "PasswordRecoveryRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source" "PasswordRecoverySource" NOT NULL,
    "organisationId" TEXT,
    "userId" TEXT,
    "identifierDigest" CHAR(64),
    "requestIpDigest" CHAR(64),
    "requestNetworkDigest" CHAR(64),
    "rateKeyVersion" INTEGER,
    "requestEvidenceRedactedAt" TIMESTAMP(3),
    "tokenHash" CHAR(64),
    "tokenNonce" CHAR(64),
    "tokenKeyVersion" INTEGER,
    "recipientEmail" TEXT,
    "recipientName" TEXT,
    "frontendOrigin" TEXT,
    "deliveryTemplateVersion" INTEGER,
    "deliveryState" "PasswordRecoveryDeliveryState" NOT NULL DEFAULT 'PENDING',
    "suppressionReason" "PasswordRecoverySuppressionReason",
    "claimToken" UUID,
    "claimedAt" TIMESTAMP(3),
    "deliveryAttemptedAt" TIMESTAMP(3),
    "deliveryFinalizedAt" TIMESTAMP(3),
    "deliveryAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextDeliveryAttemptAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "reviewAlertClaimToken" UUID,
    "reviewAlertClaimedAt" TIMESTAMP(3),
    "reviewAlertedAt" TIMESTAMP(3),
    "evidenceRetentionAnchorAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "terminatedAt" TIMESTAMP(3),
    "terminationReason" "PasswordRecoveryTerminationReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordRecoveryRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PasswordRecoveryRequest_hash_shape_check" CHECK (
        ("identifierDigest" IS NULL OR "identifierDigest" ~ '^[0-9a-f]{64}$')
        AND ("requestIpDigest" IS NULL OR "requestIpDigest" ~ '^[0-9a-f]{64}$')
        AND ("requestNetworkDigest" IS NULL OR "requestNetworkDigest" ~ '^[0-9a-f]{64}$')
        AND ("tokenHash" IS NULL OR "tokenHash" ~ '^[0-9a-f]{64}$')
        AND ("tokenNonce" IS NULL OR "tokenNonce" ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT "PasswordRecoveryRequest_key_version_check" CHECK (
        ("rateKeyVersion" IS NULL OR "rateKeyVersion" > 0)
        AND ("tokenKeyVersion" IS NULL OR "tokenKeyVersion" > 0)
        AND ("deliveryTemplateVersion" IS NULL OR "deliveryTemplateVersion" = 1)
    ),
    CONSTRAINT "PasswordRecoveryRequest_attempt_count_check" CHECK (
        "deliveryAttemptCount" BETWEEN 0 AND 3
    ),
    CONSTRAINT "PasswordRecoveryRequest_termination_tuple_check" CHECK (
        (
            "terminatedAt" IS NULL
            AND "terminationReason" IS NULL
        )
        OR (
            "terminatedAt" IS NOT NULL
            AND "terminationReason" IS NOT NULL
            AND "nextDeliveryAttemptAt" IS NULL
        )
    ),
    CONSTRAINT "PasswordRecoveryRequest_timeline_check" CHECK (
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
                    'PERSONAL_SERVER_OPERATOR'::"PasswordRecoverySource"
                )
                AND "claimedAt" IS NULL
                AND "deliveryAttemptedAt" IS NULL
            )
        )
    ),
    CONSTRAINT "PasswordRecoveryRequest_evidence_check" CHECK (
        ("recipientEmail" IS NULL OR (
            "recipientEmail" = BTRIM("recipientEmail")
            AND CHAR_LENGTH("recipientEmail") BETWEEN 3 AND 254
            AND "recipientEmail" !~ '[[:cntrl:]]'
        ))
        AND ("recipientName" IS NULL OR (
            "recipientName" = BTRIM("recipientName")
            AND CHAR_LENGTH("recipientName") BETWEEN 1 AND 200
            AND "recipientName" !~ '[[:cntrl:]]'
        ))
        AND ("frontendOrigin" IS NULL OR (
            "frontendOrigin" = BTRIM("frontendOrigin")
            AND CHAR_LENGTH("frontendOrigin") BETWEEN 8 AND 512
            AND "frontendOrigin" !~ '[[:cntrl:]]'
            AND "frontendOrigin" !~ '[/?#]$'
        ))
        AND ("providerMessageId" IS NULL OR (
            "providerMessageId" = BTRIM("providerMessageId")
            AND CHAR_LENGTH("providerMessageId") BETWEEN 1 AND 256
            AND "providerMessageId" !~ '[[:cntrl:]]'
        ))
    ),
    CONSTRAINT "PasswordRecoveryRequest_target_shape_check" CHECK (
        (
            "deliveryState" = 'SUPPRESSED'::"PasswordRecoveryDeliveryState"
            AND "source" = 'SELF_SERVICE_EMAIL'::"PasswordRecoverySource"
            AND "organisationId" IS NULL
            AND "userId" IS NULL
            AND "tokenHash" IS NULL
            AND "tokenNonce" IS NULL
            AND "tokenKeyVersion" IS NULL
            AND "recipientEmail" IS NULL
            AND "recipientName" IS NULL
            AND "frontendOrigin" IS NULL
            AND "deliveryTemplateVersion" IS NULL
            AND "expiresAt" IS NULL
            AND "suppressionReason" IS NOT NULL
        )
        OR
        (
            "deliveryState" <> 'SUPPRESSED'::"PasswordRecoveryDeliveryState"
            AND "organisationId" IS NOT NULL
            AND "userId" IS NOT NULL
            AND "tokenHash" IS NOT NULL
            AND "expiresAt" IS NOT NULL
            AND "suppressionReason" IS NULL
        )
    ),
    CONSTRAINT "PasswordRecoveryRequest_source_shape_check" CHECK (
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
    ),
    CONSTRAINT "PasswordRecoveryRequest_delivery_evidence_check" CHECK (
        (
            "deliveryState" = 'SUPPRESSED'::"PasswordRecoveryDeliveryState"
            AND "deliveryAttemptCount" = 0
            AND "claimToken" IS NULL
            AND "claimedAt" IS NULL
            AND "deliveryAttemptedAt" IS NULL
            AND "deliveryFinalizedAt" IS NULL
            AND "providerMessageId" IS NULL
            AND "nextDeliveryAttemptAt" IS NULL
        )
        OR
        (
            "deliveryState" = 'PENDING'::"PasswordRecoveryDeliveryState"
            AND "claimToken" IS NULL
            AND "claimedAt" IS NULL
            AND "deliveryAttemptedAt" IS NULL
            AND "deliveryFinalizedAt" IS NULL
            AND "providerMessageId" IS NULL
            AND (
                ("terminatedAt" IS NULL AND "nextDeliveryAttemptAt" IS NOT NULL)
                OR
                ("terminatedAt" IS NOT NULL AND "nextDeliveryAttemptAt" IS NULL)
            )
        )
        OR
        (
            "deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState"
            AND "deliveryAttemptCount" BETWEEN 1 AND 3
            AND "claimToken" IS NOT NULL
            AND "claimedAt" IS NOT NULL
            AND "deliveryAttemptedAt" IS NOT NULL
            AND "deliveryFinalizedAt" IS NULL
            AND "providerMessageId" IS NULL
            AND "nextDeliveryAttemptAt" IS NULL
        )
        OR
        (
            "deliveryState" IN (
                'ACCEPTED'::"PasswordRecoveryDeliveryState",
                'REJECTED'::"PasswordRecoveryDeliveryState",
                'UNCERTAIN'::"PasswordRecoveryDeliveryState"
            )
            AND "claimToken" IS NULL
            AND "nextDeliveryAttemptAt" IS NULL
            AND (
                "source" <> 'SELF_SERVICE_EMAIL'::"PasswordRecoverySource"
                OR (
                    "deliveryAttemptCount" BETWEEN 1 AND 3
                    AND "claimedAt" IS NOT NULL
                    AND "deliveryAttemptedAt" IS NOT NULL
                    AND "deliveryFinalizedAt" IS NOT NULL
                )
            )
            AND (
                "deliveryState" <> 'ACCEPTED'::"PasswordRecoveryDeliveryState"
                OR "source" <> 'SELF_SERVICE_EMAIL'::"PasswordRecoverySource"
                OR "providerMessageId" IS NOT NULL
            )
            AND (
                "deliveryState" = 'ACCEPTED'::"PasswordRecoveryDeliveryState"
                OR "providerMessageId" IS NULL
            )
        )
    ),
    CONSTRAINT "PasswordRecoveryRequest_rejected_termination_check" CHECK (
        "deliveryState" <> 'REJECTED'::"PasswordRecoveryDeliveryState"
        OR (
            "terminatedAt" IS NOT NULL
            AND "terminationReason" IS NOT NULL
        )
    ),
    CONSTRAINT "PasswordRecoveryRequest_review_alert_check" CHECK (
        (("reviewAlertClaimToken" IS NULL) = ("reviewAlertClaimedAt" IS NULL))
        AND (
            "reviewAlertedAt" IS NULL
            OR (
                "reviewAlertClaimToken" IS NULL
                AND "reviewAlertClaimedAt" IS NULL
            )
        )
        AND (
            "reviewAlertClaimedAt" IS NULL
            OR "reviewAlertClaimedAt" >= "createdAt"
        )
        AND (
            "reviewAlertedAt" IS NULL
            OR "reviewAlertedAt" >= "createdAt"
        )
        AND (
            (
                "reviewAlertClaimToken" IS NULL
                AND "reviewAlertClaimedAt" IS NULL
                AND "reviewAlertedAt" IS NULL
            )
            OR (
                "source" = 'SELF_SERVICE_EMAIL'::"PasswordRecoverySource"
                AND (
                    "deliveryState" IN (
                        'REJECTED'::"PasswordRecoveryDeliveryState",
                        'UNCERTAIN'::"PasswordRecoveryDeliveryState"
                    )
                    OR "terminationReason" = 'KEY_UNAVAILABLE'::"PasswordRecoveryTerminationReason"
                )
            )
        )
    ),
    CONSTRAINT "PasswordRecoveryRequest_reason_state_check" CHECK (
        (
            "deliveryState" <> 'SUPPRESSED'::"PasswordRecoveryDeliveryState"
            OR "terminatedAt" IS NULL
        )
        AND (
            "terminationReason" IS DISTINCT FROM 'KEY_UNAVAILABLE'::"PasswordRecoveryTerminationReason"
            OR (
                "source" = 'SELF_SERVICE_EMAIL'::"PasswordRecoverySource"
                AND "deliveryState" = 'PENDING'::"PasswordRecoveryDeliveryState"
                AND "deliveryAttemptCount" = 0
                AND "claimToken" IS NULL
                AND "claimedAt" IS NULL
                AND "deliveryAttemptedAt" IS NULL
                AND "deliveryFinalizedAt" IS NULL
                AND "providerMessageId" IS NULL
            )
        )
        AND (
            "terminationReason" IS DISTINCT FROM 'DELIVERY_REJECTED'::"PasswordRecoveryTerminationReason"
            OR "deliveryState" = 'REJECTED'::"PasswordRecoveryDeliveryState"
        )
    )
);

CREATE TABLE "AuthRecoveryRateLimitBucket" (
    "scope" "AuthRecoveryRateLimitScope" NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "subjectDigest" CHAR(64) NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "windowEndsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthRecoveryRateLimitBucket_pkey"
        PRIMARY KEY ("scope", "keyVersion", "subjectDigest", "windowStartedAt"),
    CONSTRAINT "AuthRecoveryRateLimitBucket_shape_check" CHECK (
        "keyVersion" > 0
        AND "subjectDigest" ~ '^[0-9a-f]{64}$'
        AND "count" >= 1
        AND "windowEndsAt" > "windowStartedAt"
        AND "expiresAt" > "windowEndsAt"
        AND "expiresAt" <= "windowEndsAt" + INTERVAL '24 hours'
    )
);

CREATE TABLE "AuthRecoveryControl" (
    "id" INTEGER NOT NULL,
    "blocked" BOOLEAN NOT NULL DEFAULT FALSE,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "activeSecretFingerprint" CHAR(64),
    "retiredSecretFingerprint" CHAR(64),
    "blockedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthRecoveryControl_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuthRecoveryControl_singleton_check" CHECK ("id" = 1),
    CONSTRAINT "AuthRecoveryControl_generation_check" CHECK ("generation" >= 1),
    CONSTRAINT "AuthRecoveryControl_fingerprint_check" CHECK (
        ("activeSecretFingerprint" IS NULL OR "activeSecretFingerprint" ~ '^[0-9a-f]{64}$')
        AND (
            "retiredSecretFingerprint" IS NULL
            OR "retiredSecretFingerprint" ~ '^[0-9a-f]{64}$'
        )
        AND (
            "activeSecretFingerprint" IS NULL
            OR "activeSecretFingerprint" IS DISTINCT FROM "retiredSecretFingerprint"
        )
    ),
    CONSTRAINT "AuthRecoveryControl_state_check" CHECK (
        (
            "generation" = 1
            AND NOT "blocked"
            AND "activeSecretFingerprint" IS NULL
            AND "retiredSecretFingerprint" IS NULL
            AND "blockedAt" IS NULL
            AND "activatedAt" IS NULL
        )
        OR (
            "blocked"
            AND "activeSecretFingerprint" IS NULL
            AND "retiredSecretFingerprint" IS NOT NULL
            AND "blockedAt" IS NOT NULL
            AND "activatedAt" IS NULL
        )
        OR (
            NOT "blocked"
            AND "activeSecretFingerprint" IS NOT NULL
            AND "blockedAt" IS NULL
            AND "activatedAt" IS NOT NULL
        )
    ),
    CONSTRAINT "AuthRecoveryControl_timeline_check" CHECK (
        ("blockedAt" IS NULL OR "blockedAt" >= "createdAt")
        AND ("activatedAt" IS NULL OR "activatedAt" >= "createdAt")
    )
);

INSERT INTO "AuthRecoveryControl" ("id") VALUES (1);

CREATE TABLE "AuthRecoveryRetiredSecret" (
    "fingerprint" CHAR(64) NOT NULL,
    "retiredGeneration" INTEGER NOT NULL,
    "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthRecoveryRetiredSecret_pkey" PRIMARY KEY ("fingerprint"),
    CONSTRAINT "AuthRecoveryRetiredSecret_retiredGeneration_key" UNIQUE ("retiredGeneration"),
    CONSTRAINT "AuthRecoveryRetiredSecret_fingerprint_check" CHECK (
        "fingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "AuthRecoveryRetiredSecret_generation_check" CHECK (
        "retiredGeneration" >= 1
    )
);

CREATE FUNCTION "guard_auth_recovery_retired_secret"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    current_control "AuthRecoveryControl"%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Retired authentication recovery fingerprints are append-only'
            USING ERRCODE = '55000';
    END IF;

    SELECT *
    INTO current_control
    FROM "AuthRecoveryControl"
    WHERE "id" = 1
    FOR SHARE;

    IF current_control."id" IS NULL
       OR current_control."blocked"
       OR current_control."activeSecretFingerprint" IS DISTINCT FROM NEW."fingerprint"
       OR current_control."generation" IS DISTINCT FROM NEW."retiredGeneration" THEN
        RAISE EXCEPTION 'Retired authentication recovery fingerprint must bind the current active generation'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AuthRecoveryRetiredSecret_guard_integrity"
    BEFORE INSERT OR UPDATE OR DELETE ON "AuthRecoveryRetiredSecret"
    FOR EACH ROW EXECUTE FUNCTION "guard_auth_recovery_retired_secret"();

CREATE FUNCTION "reject_auth_recovery_retired_secret_truncate"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Retired authentication recovery fingerprints cannot be truncated'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "AuthRecoveryRetiredSecret_reject_truncate"
    BEFORE TRUNCATE ON "AuthRecoveryRetiredSecret"
    FOR EACH STATEMENT EXECUTE FUNCTION "reject_auth_recovery_retired_secret_truncate"();

CREATE FUNCTION "guard_auth_recovery_control"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        RAISE EXCEPTION 'Authentication recovery control is a migration-owned singleton'
            USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Authentication recovery control cannot be deleted'
            USING ERRCODE = '55000';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'Authentication recovery control identity is immutable'
            USING ERRCODE = '55000';
    END IF;

    IF OLD."generation" = 1
       AND NOT OLD."blocked"
       AND OLD."activeSecretFingerprint" IS NULL
       AND OLD."retiredSecretFingerprint" IS NULL
       AND NOT NEW."blocked"
       AND NEW."generation" = 1
       AND NEW."activeSecretFingerprint" IS NOT NULL
       AND NEW."retiredSecretFingerprint" IS NULL
       AND NEW."blockedAt" IS NULL
       AND NEW."activatedAt" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM "AuthRecoveryRetiredSecret"
           WHERE "fingerprint" = NEW."activeSecretFingerprint"
       ) THEN
        RETURN NEW;
    END IF;

    IF NOT OLD."blocked"
       AND OLD."activeSecretFingerprint" IS NOT NULL
       AND NEW."blocked"
       AND NEW."generation" = OLD."generation" + 1
       AND NEW."activeSecretFingerprint" IS NULL
       AND NEW."retiredSecretFingerprint" = OLD."activeSecretFingerprint"
       AND NEW."blockedAt" IS NOT NULL
       AND NEW."activatedAt" IS NULL
       AND EXISTS (
           SELECT 1 FROM "AuthRecoveryRetiredSecret"
           WHERE "fingerprint" = OLD."activeSecretFingerprint"
             AND "retiredGeneration" = OLD."generation"
       ) THEN
        RETURN NEW;
    END IF;

    IF OLD."blocked"
       AND OLD."activeSecretFingerprint" IS NULL
       AND OLD."retiredSecretFingerprint" IS NOT NULL
       AND NOT NEW."blocked"
       AND NEW."generation" = OLD."generation"
       AND NEW."activeSecretFingerprint" IS NOT NULL
       AND NEW."retiredSecretFingerprint" = OLD."retiredSecretFingerprint"
       AND NEW."blockedAt" IS NULL
       AND NEW."activatedAt" IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM "AuthRecoveryRetiredSecret"
           WHERE "fingerprint" = NEW."activeSecretFingerprint"
       ) THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Illegal authentication recovery control transition'
        USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "AuthRecoveryControl_guard_integrity"
    BEFORE INSERT OR UPDATE OR DELETE ON "AuthRecoveryControl"
    FOR EACH ROW EXECUTE FUNCTION "guard_auth_recovery_control"();

CREATE TABLE "AuthSecurityEmailOutbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "AuthSecurityEmailKind" NOT NULL,
    "organisationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "auditEventId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "deliveryTemplateVersion" INTEGER NOT NULL DEFAULT 1,
    "deliveryState" "AuthSecurityEmailDeliveryState" NOT NULL DEFAULT 'PENDING',
    "claimToken" UUID,
    "claimedAt" TIMESTAMP(3),
    "deliveryAttemptedAt" TIMESTAMP(3),
    "deliveryFinalizedAt" TIMESTAMP(3),
    "deliveryAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextDeliveryAttemptAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "reviewAlertClaimToken" UUID,
    "reviewAlertClaimedAt" TIMESTAMP(3),
    "reviewAlertedAt" TIMESTAMP(3),
    "evidenceRetentionAnchorAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSecurityEmailOutbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuthSecurityEmailOutbox_attempt_count_check" CHECK (
        "deliveryAttemptCount" BETWEEN 0 AND 3
    ),
    CONSTRAINT "AuthSecurityEmailOutbox_template_version_check" CHECK (
        "deliveryTemplateVersion" = 1
    ),
    CONSTRAINT "AuthSecurityEmailOutbox_timeline_check" CHECK (
        ("claimedAt" IS NULL OR "claimedAt" >= "createdAt")
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
        AND "evidenceRetentionAnchorAt" >= "createdAt"
    ),
    CONSTRAINT "AuthSecurityEmailOutbox_recipient_check" CHECK (
        "recipientEmail" = BTRIM("recipientEmail")
        AND CHAR_LENGTH("recipientEmail") BETWEEN 3 AND 254
        AND "recipientEmail" !~ '[[:cntrl:]]'
        AND "recipientName" = BTRIM("recipientName")
        AND CHAR_LENGTH("recipientName") BETWEEN 1 AND 200
        AND "recipientName" !~ '[[:cntrl:]]'
        AND (
            "providerMessageId" IS NULL
            OR (
                "providerMessageId" = BTRIM("providerMessageId")
                AND CHAR_LENGTH("providerMessageId") BETWEEN 1 AND 256
                AND "providerMessageId" !~ '[[:cntrl:]]'
            )
        )
    ),
    CONSTRAINT "AuthSecurityEmailOutbox_review_alert_check" CHECK (
        (("reviewAlertClaimToken" IS NULL) = ("reviewAlertClaimedAt" IS NULL))
        AND (
            "reviewAlertedAt" IS NULL
            OR (
                "reviewAlertClaimToken" IS NULL
                AND "reviewAlertClaimedAt" IS NULL
            )
        )
        AND (
            "reviewAlertClaimedAt" IS NULL
            OR "reviewAlertClaimedAt" >= "createdAt"
        )
        AND (
            "reviewAlertedAt" IS NULL
            OR "reviewAlertedAt" >= "createdAt"
        )
        AND (
            (
                "reviewAlertClaimToken" IS NULL
                AND "reviewAlertClaimedAt" IS NULL
                AND "reviewAlertedAt" IS NULL
            )
            OR "deliveryState" IN (
                'REJECTED'::"AuthSecurityEmailDeliveryState",
                'UNCERTAIN'::"AuthSecurityEmailDeliveryState"
            )
        )
    ),
    CONSTRAINT "AuthSecurityEmailOutbox_delivery_evidence_check" CHECK (
        (
            "deliveryState" = 'PENDING'::"AuthSecurityEmailDeliveryState"
            AND "claimToken" IS NULL
            AND "claimedAt" IS NULL
            AND "deliveryAttemptedAt" IS NULL
            AND "deliveryFinalizedAt" IS NULL
            AND "providerMessageId" IS NULL
            AND "nextDeliveryAttemptAt" IS NOT NULL
        )
        OR
        (
            "deliveryState" = 'SENDING'::"AuthSecurityEmailDeliveryState"
            AND "deliveryAttemptCount" BETWEEN 1 AND 3
            AND "claimToken" IS NOT NULL
            AND "claimedAt" IS NOT NULL
            AND "deliveryAttemptedAt" IS NOT NULL
            AND "deliveryFinalizedAt" IS NULL
            AND "providerMessageId" IS NULL
            AND "nextDeliveryAttemptAt" IS NULL
        )
        OR
        (
            "deliveryState" IN (
                'ACCEPTED'::"AuthSecurityEmailDeliveryState",
                'REJECTED'::"AuthSecurityEmailDeliveryState",
                'UNCERTAIN'::"AuthSecurityEmailDeliveryState"
            )
            AND "claimToken" IS NULL
            AND "nextDeliveryAttemptAt" IS NULL
            AND "deliveryFinalizedAt" IS NOT NULL
            AND "deliveryAttemptCount" BETWEEN 1 AND 3
            AND "claimedAt" IS NOT NULL
            AND "deliveryAttemptedAt" IS NOT NULL
            AND (
                "deliveryState" <> 'ACCEPTED'::"AuthSecurityEmailDeliveryState"
                OR "providerMessageId" IS NOT NULL
            )
            AND (
                "deliveryState" = 'ACCEPTED'::"AuthSecurityEmailDeliveryState"
                OR "providerMessageId" IS NULL
            )
        )
    )
);

ALTER TABLE "PasswordRecoveryRequest"
    ADD CONSTRAINT "PasswordRecoveryRequest_organisationId_fkey"
        FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "PasswordRecoveryRequest_userId_organisationId_fkey"
        FOREIGN KEY ("userId", "organisationId") REFERENCES "User"("id", "organisationId")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "SecurityAuditEvent_id_organisationId_key"
    ON "SecurityAuditEvent"("id", "organisationId");

ALTER TABLE "AuthSecurityEmailOutbox"
    ADD CONSTRAINT "AuthSecurityEmailOutbox_organisationId_fkey"
        FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AuthSecurityEmailOutbox_userId_organisationId_fkey"
        FOREIGN KEY ("userId", "organisationId") REFERENCES "User"("id", "organisationId")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AuthSecurityEmailOutbox_auditEventId_organisationId_fkey"
        FOREIGN KEY ("auditEventId", "organisationId")
        REFERENCES "SecurityAuditEvent"("id", "organisationId")
        ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "PasswordRecoveryRequest_tokenHash_key"
    ON "PasswordRecoveryRequest"("tokenHash");
CREATE UNIQUE INDEX "PasswordRecoveryRequest_providerMessageId_key"
    ON "PasswordRecoveryRequest"("providerMessageId");
CREATE INDEX "PasswordRecoveryRequest_userId_terminatedAt_expiresAt_id_idx"
    ON "PasswordRecoveryRequest"("userId", "terminatedAt", "expiresAt", "id");
CREATE INDEX "PasswordRecoveryRequest_deliveryState_nextDeliveryAttemptAt_id_idx"
    ON "PasswordRecoveryRequest"("deliveryState", "nextDeliveryAttemptAt", "id");
CREATE INDEX "PasswordRecoveryRequest_deliveryState_claimedAt_id_idx"
    ON "PasswordRecoveryRequest"("deliveryState", "claimedAt", "id");
CREATE INDEX "PasswordRecoveryRequest_reviewAlertedAt_reviewAlertClaimedAt_createdAt_id_idx"
    ON "PasswordRecoveryRequest"("reviewAlertedAt", "reviewAlertClaimedAt", "createdAt", "id");
CREATE INDEX "PasswordRecoveryRequest_evidenceRetentionAnchorAt_id_idx"
    ON "PasswordRecoveryRequest"("evidenceRetentionAnchorAt", "id");
CREATE INDEX "PasswordRecoveryRequest_expiresAt_id_idx"
    ON "PasswordRecoveryRequest"("expiresAt", "id");
CREATE INDEX "PasswordRecoveryRequest_createdAt_id_idx"
    ON "PasswordRecoveryRequest"("createdAt", "id");
CREATE INDEX "AuthRecoveryRateLimitBucket_expiresAt_idx"
    ON "AuthRecoveryRateLimitBucket"("expiresAt");
CREATE UNIQUE INDEX "AuthSecurityEmailOutbox_auditEventId_key"
    ON "AuthSecurityEmailOutbox"("auditEventId");
CREATE UNIQUE INDEX "AuthSecurityEmailOutbox_providerMessageId_key"
    ON "AuthSecurityEmailOutbox"("providerMessageId");
CREATE INDEX "AuthSecurityEmailOutbox_deliveryState_nextDeliveryAttemptAt_id_idx"
    ON "AuthSecurityEmailOutbox"("deliveryState", "nextDeliveryAttemptAt", "id");
CREATE INDEX "AuthSecurityEmailOutbox_deliveryState_claimedAt_id_idx"
    ON "AuthSecurityEmailOutbox"("deliveryState", "claimedAt", "id");
CREATE INDEX "AuthSecurityEmailOutbox_reviewAlertedAt_reviewAlertClaimedAt_createdAt_id_idx"
    ON "AuthSecurityEmailOutbox"("reviewAlertedAt", "reviewAlertClaimedAt", "createdAt", "id");
CREATE INDEX "AuthSecurityEmailOutbox_evidenceRetentionAnchorAt_id_idx"
    ON "AuthSecurityEmailOutbox"("evidenceRetentionAnchorAt", "id");
CREATE INDEX "AuthSecurityEmailOutbox_createdAt_id_idx"
    ON "AuthSecurityEmailOutbox"("createdAt", "id");

-- Preserve only still-usable legacy links. Their historical provider result is
-- unknowable, so UNCERTAIN is the only truthful delivery classification.
INSERT INTO "PasswordRecoveryRequest" (
    "id", "source", "organisationId", "userId", "tokenHash",
    "deliveryState", "deliveryFinalizedAt", "expiresAt", "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid(),
    'LEGACY_USER_SLOT'::"PasswordRecoverySource",
    account."organisationId",
    account."id",
    account."resetToken",
    'UNCERTAIN'::"PasswordRecoveryDeliveryState",
    CURRENT_TIMESTAMP,
    account."resetTokenExpiry",
    account."resetTokenExpiry" - INTERVAL '1 hour',
    CURRENT_TIMESTAMP
FROM "User" AS account
JOIN "Organisation" AS organisation
  ON organisation."id" = account."organisationId"
WHERE account."resetToken" IS NOT NULL
  AND account."resetTokenExpiry" > CURRENT_TIMESTAMP
  AND account."lifecycleStatus" = 'ACTIVE'::"UserLifecycleStatus"
  AND organisation."lifecycleStatus" = 'ACTIVE'::"OrganisationLifecycleStatus";

-- The ledger row above is the sole roll-forward representation of every usable
-- pre-cutover p109 link. Retire both legacy columns in the same migration
-- transaction for all principals; current runtimes never dual-write them.
UPDATE "User"
SET "resetToken" = NULL,
    "resetTokenExpiry" = NULL
WHERE "resetToken" IS NOT NULL OR "resetTokenExpiry" IS NOT NULL;

CREATE FUNCTION "guard_password_recovery_request"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    outstanding_count INTEGER;
    organisation_status "OrganisationLifecycleStatus";
    user_status "UserLifecycleStatus";
    user_email TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW."evidenceRetentionAnchorAt" := GREATEST(
            NEW."createdAt",
            COALESCE(NEW."deliveryFinalizedAt", NEW."createdAt"),
            COALESCE(NEW."terminatedAt", NEW."createdAt"),
            COALESCE(NEW."reviewAlertedAt", NEW."createdAt")
        );
        IF NEW."requestEvidenceRedactedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'Password recovery request evidence must begin unredacted'
                USING ERRCODE = '23514';
        END IF;

        IF NEW."reviewAlertClaimToken" IS NOT NULL
           OR NEW."reviewAlertClaimedAt" IS NOT NULL
           OR NEW."reviewAlertedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'Password recovery review alert evidence must begin unclaimed'
                USING ERRCODE = '23514';
        END IF;

        IF NEW."deliveryState" <> 'SUPPRESSED'::"PasswordRecoveryDeliveryState" THEN
            SELECT "lifecycleStatus"
            INTO organisation_status
            FROM "Organisation"
            WHERE "id" = NEW."organisationId"
            FOR SHARE;

            SELECT "lifecycleStatus", "email"
            INTO user_status, user_email
            FROM "User"
            WHERE "id" = NEW."userId"
              AND "organisationId" = NEW."organisationId"
            FOR UPDATE;

            IF organisation_status IS DISTINCT FROM 'ACTIVE'::"OrganisationLifecycleStatus"
               OR user_status IS DISTINCT FROM 'ACTIVE'::"UserLifecycleStatus" THEN
                RAISE EXCEPTION 'Password recovery requests require an active organisation and active user'
                    USING ERRCODE = '23514',
                          CONSTRAINT = 'PasswordRecoveryRequest_active_principal';
            END IF;

            IF NEW."source" = 'SELF_SERVICE_EMAIL'::"PasswordRecoverySource"
               AND NEW."recipientEmail" IS DISTINCT FROM user_email THEN
                RAISE EXCEPTION 'Password recovery recipient must match the locked user email'
                    USING ERRCODE = '23514',
                          CONSTRAINT = 'PasswordRecoveryRequest_recipient_authority';
            END IF;

            IF NEW."terminatedAt" IS NULL THEN
                SELECT COUNT(*)::INTEGER
                INTO outstanding_count
                FROM "PasswordRecoveryRequest"
                WHERE "userId" = NEW."userId"
                  AND "terminatedAt" IS NULL
                  AND "expiresAt" > CURRENT_TIMESTAMP
                  AND "deliveryState" IN (
                      'PENDING'::"PasswordRecoveryDeliveryState",
                      'SENDING'::"PasswordRecoveryDeliveryState",
                      'ACCEPTED'::"PasswordRecoveryDeliveryState",
                      'UNCERTAIN'::"PasswordRecoveryDeliveryState"
                  );

                IF outstanding_count >= 3 THEN
                    RAISE EXCEPTION 'Password recovery outstanding request limit reached'
                        USING ERRCODE = '23514',
                              CONSTRAINT = 'PasswordRecoveryRequest_outstanding_limit';
                END IF;
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    NEW."evidenceRetentionAnchorAt" := GREATEST(
        OLD."evidenceRetentionAnchorAt",
        COALESCE(NEW."deliveryFinalizedAt", OLD."evidenceRetentionAnchorAt"),
        COALESCE(NEW."terminatedAt", OLD."evidenceRetentionAnchorAt"),
        COALESCE(NEW."reviewAlertedAt", OLD."evidenceRetentionAnchorAt")
    );

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."source" IS DISTINCT FROM OLD."source"
       OR NEW."organisationId" IS DISTINCT FROM OLD."organisationId"
       OR NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
       OR NEW."tokenNonce" IS DISTINCT FROM OLD."tokenNonce"
       OR NEW."tokenKeyVersion" IS DISTINCT FROM OLD."tokenKeyVersion"
       OR NEW."recipientEmail" IS DISTINCT FROM OLD."recipientEmail"
       OR NEW."recipientName" IS DISTINCT FROM OLD."recipientName"
       OR NEW."frontendOrigin" IS DISTINCT FROM OLD."frontendOrigin"
       OR NEW."deliveryTemplateVersion" IS DISTINCT FROM OLD."deliveryTemplateVersion"
       OR NEW."suppressionReason" IS DISTINCT FROM OLD."suppressionReason"
       OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'Password recovery identity and recipient evidence are immutable'
            USING ERRCODE = '23514';
    END IF;

    IF (
           NEW."identifierDigest" IS DISTINCT FROM OLD."identifierDigest"
           OR NEW."requestIpDigest" IS DISTINCT FROM OLD."requestIpDigest"
           OR NEW."requestNetworkDigest" IS DISTINCT FROM OLD."requestNetworkDigest"
           OR NEW."rateKeyVersion" IS DISTINCT FROM OLD."rateKeyVersion"
           OR NEW."requestEvidenceRedactedAt" IS DISTINCT FROM OLD."requestEvidenceRedactedAt"
       )
       AND NOT (
           OLD."source" = 'SELF_SERVICE_EMAIL'::"PasswordRecoverySource"
           AND OLD."requestEvidenceRedactedAt" IS NULL
           AND NEW."requestEvidenceRedactedAt" IS NOT NULL
           AND NEW."identifierDigest" IS NULL
           AND NEW."requestIpDigest" IS NULL
           AND NEW."requestNetworkDigest" IS NULL
           AND NEW."rateKeyVersion" IS NULL
       ) THEN
        RAISE EXCEPTION 'Password recovery keyed request evidence is immutable except for one-way redaction'
            USING ERRCODE = '55000';
    END IF;

    IF OLD."terminatedAt" IS NOT NULL
       AND (
           NEW."terminatedAt" IS DISTINCT FROM OLD."terminatedAt"
           OR NEW."terminationReason" IS DISTINCT FROM OLD."terminationReason"
       ) THEN
        RAISE EXCEPTION 'Password recovery termination evidence is immutable'
            USING ERRCODE = '55000';
    END IF;

    IF OLD."reviewAlertedAt" IS NOT NULL
       AND (
           NEW."reviewAlertClaimToken" IS DISTINCT FROM OLD."reviewAlertClaimToken"
           OR NEW."reviewAlertClaimedAt" IS DISTINCT FROM OLD."reviewAlertClaimedAt"
           OR NEW."reviewAlertedAt" IS DISTINCT FROM OLD."reviewAlertedAt"
       ) THEN
        RAISE EXCEPTION 'Acknowledged password recovery review alert evidence is immutable'
            USING ERRCODE = '55000';
    END IF;

    IF OLD."reviewAlertedAt" IS NULL
       AND NEW."reviewAlertedAt" IS NOT NULL
       AND OLD."reviewAlertClaimToken" IS NULL THEN
        RAISE EXCEPTION 'Password recovery review alert acknowledgement requires a claim'
            USING ERRCODE = '23514';
    END IF;

    IF OLD."deliveryState" = 'PENDING'::"PasswordRecoveryDeliveryState"
       AND NEW."deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState" THEN
        IF NEW."deliveryAttemptCount" <> OLD."deliveryAttemptCount" + 1 THEN
            RAISE EXCEPTION 'Password recovery claim must increment attempts exactly once'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW."deliveryAttemptCount" IS DISTINCT FROM OLD."deliveryAttemptCount" THEN
        RAISE EXCEPTION 'Password recovery attempts may change only during a valid claim'
            USING ERRCODE = '23514';
    END IF;

    IF OLD."deliveryState" IN (
           'ACCEPTED'::"PasswordRecoveryDeliveryState",
           'REJECTED'::"PasswordRecoveryDeliveryState",
           'UNCERTAIN'::"PasswordRecoveryDeliveryState"
       )
       AND (
           NEW."claimToken" IS DISTINCT FROM OLD."claimToken"
           OR NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt"
           OR NEW."deliveryAttemptedAt" IS DISTINCT FROM OLD."deliveryAttemptedAt"
           OR NEW."deliveryFinalizedAt" IS DISTINCT FROM OLD."deliveryFinalizedAt"
           OR NEW."deliveryAttemptCount" IS DISTINCT FROM OLD."deliveryAttemptCount"
           OR NEW."nextDeliveryAttemptAt" IS DISTINCT FROM OLD."nextDeliveryAttemptAt"
           OR NEW."providerMessageId" IS DISTINCT FROM OLD."providerMessageId"
       ) THEN
        RAISE EXCEPTION 'Terminal password recovery delivery evidence is immutable'
            USING ERRCODE = '55000';
    END IF;

    IF NEW."deliveryState" IS DISTINCT FROM OLD."deliveryState"
       AND NOT (
           (OLD."deliveryState" = 'PENDING'::"PasswordRecoveryDeliveryState"
            AND OLD."terminatedAt" IS NULL
            AND NEW."deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState")
           OR
           (OLD."deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState"
            AND NEW."deliveryState" IN (
                'ACCEPTED'::"PasswordRecoveryDeliveryState",
                'REJECTED'::"PasswordRecoveryDeliveryState",
                'UNCERTAIN'::"PasswordRecoveryDeliveryState"
            ))
           OR
           (OLD."deliveryState" = 'SENDING'::"PasswordRecoveryDeliveryState"
            AND OLD."terminatedAt" IS NULL
            AND NEW."deliveryState" = 'PENDING'::"PasswordRecoveryDeliveryState")
       ) THEN
        RAISE EXCEPTION 'Illegal password recovery delivery-state transition'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "PasswordRecoveryRequest_guard_integrity"
    BEFORE INSERT OR UPDATE ON "PasswordRecoveryRequest"
    FOR EACH ROW EXECUTE FUNCTION "guard_password_recovery_request"();

-- Password changes outside the recovery endpoint must invalidate every
-- outstanding capability. This remains a database invariant, not a rollback
-- bridge: p109 images are on the preceding compatibility line and may run only
-- against an exact restored pre-P107A database.
CREATE FUNCTION "invalidate_password_recovery_on_password_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    invalidated_at TIMESTAMP(3);
BEGIN
    IF NEW."passwordHash" IS DISTINCT FROM OLD."passwordHash" THEN
        -- CURRENT_TIMESTAMP is fixed at transaction start. A transaction can
        -- begin, wait behind a recovery-request writer, and acquire the User
        -- row only after that newer request commits. Use the wall clock after
        -- the row lock is held so termination can never predate createdAt.
        invalidated_at := clock_timestamp()::timestamp(3);
        NEW."resetToken" := NULL;
        NEW."resetTokenExpiry" := NULL;

        UPDATE "PasswordRecoveryRequest"
        SET "terminatedAt" = invalidated_at,
            "terminationReason" = 'PASSWORD_RESET_COMPLETED'::"PasswordRecoveryTerminationReason",
            "nextDeliveryAttemptAt" = NULL,
            "updatedAt" = invalidated_at
        WHERE "userId" = OLD."id"
          AND "organisationId" = OLD."organisationId"
          AND "terminatedAt" IS NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "User_invalidate_password_recovery_on_password_change"
    BEFORE UPDATE OF "passwordHash" ON "User"
    FOR EACH ROW EXECUTE FUNCTION "invalidate_password_recovery_on_password_change"();

CREATE FUNCTION "guard_retired_user_password_recovery_slot"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."resetToken" IS NOT NULL OR NEW."resetTokenExpiry" IS NOT NULL THEN
        RAISE EXCEPTION 'Legacy User password recovery slots are retired on the P107A compatibility line'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "User_guard_retired_password_recovery_slot"
    BEFORE INSERT OR UPDATE ON "User"
    FOR EACH ROW EXECUTE FUNCTION "guard_retired_user_password_recovery_slot"();

CREATE FUNCTION "guard_auth_security_email_outbox"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    audit_subject_user_id TEXT;
    audit_type "SecurityAuditEventType";
    audit_actor_kind "SecurityAuditActorKind";
    audit_event_kind TEXT;
    audit_method TEXT;
    audit_recovery_request_id TEXT;
    audit_occurred_at TIMESTAMP(3);
    recovery_request_id UUID;
    recovery_terminated_at TIMESTAMP(3);
    recovery_termination_reason "PasswordRecoveryTerminationReason";
    recovery_delivery_state "PasswordRecoveryDeliveryState";
    user_email TEXT;
    user_status "UserLifecycleStatus";
    organisation_status "OrganisationLifecycleStatus";
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW."evidenceRetentionAnchorAt" := GREATEST(
            NEW."createdAt",
            COALESCE(NEW."deliveryFinalizedAt", NEW."createdAt"),
            COALESCE(NEW."reviewAlertedAt", NEW."createdAt")
        );
        IF NEW."reviewAlertClaimToken" IS NOT NULL
           OR NEW."reviewAlertClaimedAt" IS NOT NULL
           OR NEW."reviewAlertedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'Auth security email review alert evidence must begin unclaimed'
                USING ERRCODE = '23514';
        END IF;

        SELECT
            audit."subjectUserId", audit."type", audit."actorKind",
            audit."context" ->> 'eventKind', audit."context" ->> 'method',
            audit."context" ->> 'recoveryRequestId', audit."occurredAt",
            recovery."id", recovery."terminatedAt", recovery."terminationReason",
            recovery."deliveryState",
            account."email", account."lifecycleStatus", organisation."lifecycleStatus"
        INTO
            audit_subject_user_id, audit_type, audit_actor_kind,
            audit_event_kind, audit_method,
            audit_recovery_request_id, audit_occurred_at,
            recovery_request_id, recovery_terminated_at, recovery_termination_reason,
            recovery_delivery_state,
            user_email, user_status, organisation_status
        FROM "SecurityAuditEvent" AS audit
        JOIN "User" AS account
          ON account."id" = NEW."userId"
         AND account."organisationId" = NEW."organisationId"
        JOIN "Organisation" AS organisation
          ON organisation."id" = NEW."organisationId"
        JOIN "PasswordRecoveryRequest" AS recovery
          ON recovery."id" = CASE
               WHEN (audit."context" ->> 'recoveryRequestId') ~
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                 THEN (audit."context" ->> 'recoveryRequestId')::uuid
               ELSE NULL
             END
         AND recovery."organisationId" = NEW."organisationId"
         AND recovery."userId" = NEW."userId"
        WHERE audit."id" = NEW."auditEventId"
          AND audit."organisationId" = NEW."organisationId"
        FOR SHARE OF audit, account, organisation, recovery;

        IF audit_subject_user_id IS DISTINCT FROM NEW."userId"
           OR audit_type IS DISTINCT FROM 'ALL_SESSIONS_REVOKED'::"SecurityAuditEventType"
           OR audit_actor_kind IS DISTINCT FROM 'SYSTEM'::"SecurityAuditActorKind"
           OR audit_event_kind IS DISTINCT FROM 'PASSWORD_RESET_COMPLETED'
           OR audit_method IS DISTINCT FROM 'PASSWORD_RECOVERY_LINK'
           OR audit_recovery_request_id IS DISTINCT FROM recovery_request_id::text
           OR recovery_terminated_at IS NULL
           OR recovery_terminated_at IS DISTINCT FROM audit_occurred_at
           OR recovery_termination_reason IS DISTINCT FROM
                'PASSWORD_RESET_COMPLETED'::"PasswordRecoveryTerminationReason"
           OR recovery_delivery_state NOT IN (
                'SENDING'::"PasswordRecoveryDeliveryState",
                'ACCEPTED'::"PasswordRecoveryDeliveryState",
                'UNCERTAIN'::"PasswordRecoveryDeliveryState"
           ) THEN
            RAISE EXCEPTION 'Auth security email must reference its exact password reset audit'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'AuthSecurityEmailOutbox_audit_authority';
        END IF;

        IF user_status IS DISTINCT FROM 'ACTIVE'::"UserLifecycleStatus"
           OR organisation_status IS DISTINCT FROM 'ACTIVE'::"OrganisationLifecycleStatus"
           OR NEW."recipientEmail" IS DISTINCT FROM user_email THEN
            RAISE EXCEPTION 'Auth security email recipient must match the active reset subject'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'AuthSecurityEmailOutbox_recipient_authority';
        END IF;
        RETURN NEW;
    END IF;

    NEW."evidenceRetentionAnchorAt" := GREATEST(
        OLD."evidenceRetentionAnchorAt",
        COALESCE(NEW."deliveryFinalizedAt", OLD."evidenceRetentionAnchorAt"),
        COALESCE(NEW."reviewAlertedAt", OLD."evidenceRetentionAnchorAt")
    );

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."organisationId" IS DISTINCT FROM OLD."organisationId"
       OR NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."auditEventId" IS DISTINCT FROM OLD."auditEventId"
       OR NEW."recipientEmail" IS DISTINCT FROM OLD."recipientEmail"
       OR NEW."recipientName" IS DISTINCT FROM OLD."recipientName"
       OR NEW."deliveryTemplateVersion" IS DISTINCT FROM OLD."deliveryTemplateVersion"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'Auth security email identity and recipient evidence are immutable'
            USING ERRCODE = '23514';
    END IF;

    IF OLD."deliveryState" = 'PENDING'::"AuthSecurityEmailDeliveryState"
       AND NEW."deliveryState" = 'SENDING'::"AuthSecurityEmailDeliveryState" THEN
        IF NEW."deliveryAttemptCount" <> OLD."deliveryAttemptCount" + 1 THEN
            RAISE EXCEPTION 'Auth security email claim must increment attempts exactly once'
                USING ERRCODE = '23514';
        END IF;
    ELSIF NEW."deliveryAttemptCount" IS DISTINCT FROM OLD."deliveryAttemptCount" THEN
        RAISE EXCEPTION 'Auth security email attempts may change only during a valid claim'
            USING ERRCODE = '23514';
    END IF;

    IF OLD."reviewAlertedAt" IS NOT NULL
       AND (
           NEW."reviewAlertClaimToken" IS DISTINCT FROM OLD."reviewAlertClaimToken"
           OR NEW."reviewAlertClaimedAt" IS DISTINCT FROM OLD."reviewAlertClaimedAt"
           OR NEW."reviewAlertedAt" IS DISTINCT FROM OLD."reviewAlertedAt"
       ) THEN
        RAISE EXCEPTION 'Acknowledged auth security email review alert evidence is immutable'
            USING ERRCODE = '55000';
    END IF;

    IF OLD."reviewAlertedAt" IS NULL
       AND NEW."reviewAlertedAt" IS NOT NULL
       AND OLD."reviewAlertClaimToken" IS NULL THEN
        RAISE EXCEPTION 'Auth security email review alert acknowledgement requires a claim'
            USING ERRCODE = '23514';
    END IF;

    IF OLD."deliveryState" IN (
           'ACCEPTED'::"AuthSecurityEmailDeliveryState",
           'REJECTED'::"AuthSecurityEmailDeliveryState",
           'UNCERTAIN'::"AuthSecurityEmailDeliveryState"
       )
       AND (
           NEW."claimToken" IS DISTINCT FROM OLD."claimToken"
           OR NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt"
           OR NEW."deliveryAttemptedAt" IS DISTINCT FROM OLD."deliveryAttemptedAt"
           OR NEW."deliveryFinalizedAt" IS DISTINCT FROM OLD."deliveryFinalizedAt"
           OR NEW."deliveryAttemptCount" IS DISTINCT FROM OLD."deliveryAttemptCount"
           OR NEW."nextDeliveryAttemptAt" IS DISTINCT FROM OLD."nextDeliveryAttemptAt"
           OR NEW."providerMessageId" IS DISTINCT FROM OLD."providerMessageId"
       ) THEN
        RAISE EXCEPTION 'Terminal auth security email delivery evidence is immutable'
            USING ERRCODE = '55000';
    END IF;

    IF NEW."deliveryState" IS DISTINCT FROM OLD."deliveryState"
       AND NOT (
           (OLD."deliveryState" = 'PENDING'::"AuthSecurityEmailDeliveryState"
            AND NEW."deliveryState" = 'SENDING'::"AuthSecurityEmailDeliveryState")
           OR
           (OLD."deliveryState" = 'SENDING'::"AuthSecurityEmailDeliveryState"
            AND NEW."deliveryState" IN (
                'PENDING'::"AuthSecurityEmailDeliveryState",
                'ACCEPTED'::"AuthSecurityEmailDeliveryState",
                'REJECTED'::"AuthSecurityEmailDeliveryState",
                'UNCERTAIN'::"AuthSecurityEmailDeliveryState"
            ))
       ) THEN
        RAISE EXCEPTION 'Illegal auth security email delivery-state transition'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "AuthSecurityEmailOutbox_guard_integrity"
    BEFORE INSERT OR UPDATE ON "AuthSecurityEmailOutbox"
    FOR EACH ROW EXECUTE FUNCTION "guard_auth_security_email_outbox"();

COMMENT ON TABLE "PasswordRecoveryRequest" IS
    'Bounded, tenant-bound password recovery requests; plaintext recovery tokens are never stored.';
COMMENT ON TABLE "AuthRecoveryRateLimitBucket" IS
    'PostgreSQL-authoritative keyed recovery rate-limit windows shared by all API replicas.';
COMMENT ON TABLE "AuthRecoveryControl" IS
    'Singleton generation fence binding every recovery transaction to the active root secret.';
COMMENT ON TABLE "AuthRecoveryRetiredSecret" IS
    'Append-only fingerprints and generations for every retired authentication recovery root secret.';
COMMENT ON TABLE "AuthSecurityEmailOutbox" IS
    'Durable post-reset security notification outbox bound to immutable audit evidence.';

COMMIT;
