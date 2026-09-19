BEGIN;

-- Purely additive: two new enums and one new table. Nothing existing is
-- altered, and there is no foreign key, so this migration stands on its own
-- against an empty database and cannot touch a row that already exists.

-- AddEnum
CREATE TYPE "DocumentPublicationState" AS ENUM ('PENDING', 'DEAD_LETTER', 'PROCESSED');

-- AddEnum
CREATE TYPE "DocumentPublicationTerminalReason" AS ENUM (
    'MAX_ATTEMPTS_EXHAUSTED',
    'PERMANENT_CONNECTION_UNAVAILABLE',
    'PERMANENT_PERMISSION_DENIED',
    'PERMANENT_CONFLICT_UNRESOLVED',
    'PERMANENT_CONTENT_PROPERTY_REJECTED',
    'PERMANENT_TARGET_REF_REJECTED'
);

-- CreateTable
-- organisationId and documentId are bare identifiers on purpose. A cascading
-- relation to Document would delete the pageId at the exact moment the dual
-- erasure path needs it, leaving a page in a charity's Confluence site that
-- nothing remembers how to erase.
CREATE TABLE "DocumentPublication" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'confluence',
    "cloudId" TEXT,
    "spaceId" TEXT,
    "pageId" TEXT,
    "attachmentId" TEXT,
    "pageTitle" TEXT,
    "publishedAt" TIMESTAMP(3),
    "state" "DocumentPublicationState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "terminalReason" "DocumentPublicationTerminalReason",
    "alertClaimToken" TEXT,
    "alertClaimedAt" TIMESTAMP(3),
    "alertedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The house shape: DocumentStorageDeletion, GoverningAct, Member and
    -- Resolution all give @updatedAt a database default. `migrate diff` reports
    -- it as a standing difference for each of them, because Prisma's @updatedAt
    -- is client-side and the generator emits no default. This table joins that
    -- known, benign line rather than diverging from its sibling outbox. It adds
    -- no index-name drift, which is the class that actually bites.
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentPublication_pkey" PRIMARY KEY ("id")
);

-- The same safety constraints DocumentStorageDeletion carries, so the retry
-- state machine stays fail-closed even when an application regression bypasses
-- the service methods. The attempt ceiling itself is deliberately NOT encoded
-- here: it is a service-layer policy constant, not part of the row's shape.
ALTER TABLE "DocumentPublication"
    ADD CONSTRAINT "DocumentPublication_attempts_nonnegative"
        CHECK ("attempts" >= 0),
    ADD CONSTRAINT "DocumentPublication_lastError_bounded"
        CHECK ("lastError" IS NULL OR char_length("lastError") <= 500),
    ADD CONSTRAINT "DocumentPublication_alert_claim_consistent"
        CHECK (("alertClaimToken" IS NULL) = ("alertClaimedAt" IS NULL)),
    -- A published row must say where it published to, and an unpublished one
    -- must not pretend it did. This is what the erasure path reads later.
    ADD CONSTRAINT "DocumentPublication_publication_target_consistent"
        CHECK (
            ("publishedAt" IS NULL AND "pageId" IS NULL AND "cloudId" IS NULL)
            OR
            ("publishedAt" IS NOT NULL
             AND "cloudId" IS NOT NULL AND char_length("cloudId") <= 200
             AND "cloudId" = btrim("cloudId")
             AND "pageId" IS NOT NULL AND char_length("pageId") <= 200
             AND "pageId" = btrim("pageId")
             AND ("attachmentId" IS NULL
                  OR ("attachmentId" = btrim("attachmentId") AND char_length("attachmentId") <= 200))
             AND ("spaceId" IS NULL
                  OR ("spaceId" = btrim("spaceId") AND char_length("spaceId") <= 200)))
        ),
    ADD CONSTRAINT "DocumentPublication_state_consistent"
        CHECK (
            (
                "state" = 'PENDING'
                AND "processedAt" IS NULL
                AND "publishedAt" IS NULL
                AND "deadLetteredAt" IS NULL
                AND "terminalReason" IS NULL
                AND "nextAttemptAt" IS NOT NULL
                AND "alertClaimToken" IS NULL
                AND "alertClaimedAt" IS NULL
                AND "alertedAt" IS NULL
            ) OR (
                "state" = 'DEAD_LETTER'
                AND "processedAt" IS NULL
                AND "deadLetteredAt" IS NOT NULL
                AND "terminalReason" IS NOT NULL
                AND "nextAttemptAt" IS NULL
                AND "claimedAt" IS NULL
                AND "attempts" >= 1
            ) OR (
                "state" = 'PROCESSED'
                AND "processedAt" IS NOT NULL
                AND "publishedAt" IS NOT NULL
                AND "deadLetteredAt" IS NULL
                AND "terminalReason" IS NULL
                AND "nextAttemptAt" IS NULL
                AND "claimedAt" IS NULL
                AND "lastError" IS NULL
                AND "alertClaimToken" IS NULL
                AND "alertClaimedAt" IS NULL
                AND "alertedAt" IS NULL
            )
        );

-- CreateIndex
-- createPage is non-idempotent: a retried create after a dropped connection
-- produces two pages for one board resolution with nothing saying which is
-- real. This pair is what makes a second enqueue impossible.
CREATE UNIQUE INDEX "DocumentPublication_documentId_provider_key" ON "DocumentPublication"("documentId", "provider");

-- CreateIndex
CREATE INDEX "DocumentPublication_organisationId_idx" ON "DocumentPublication"("organisationId");

-- CreateIndex
-- 63 bytes exactly, which is PostgreSQL's identifier limit. Anything longer is
-- silently truncated and reads later as permanent schema drift.
CREATE INDEX "DocumentPublication_state_nextAttemptAt_claimedAt_createdAt_idx" ON "DocumentPublication"("state", "nextAttemptAt", "claimedAt", "createdAt");

-- CreateIndex
-- Explicitly mapped in schema.prisma: the derived name would be 69 bytes.
CREATE INDEX "DocumentPublication_state_alert_deadLetteredAt_idx" ON "DocumentPublication"("state", "alertedAt", "alertClaimedAt", "deadLetteredAt");

-- CreateIndex
CREATE INDEX "DocumentPublication_organisationId_state_deadLetteredAt_idx" ON "DocumentPublication"("organisationId", "state", "deadLetteredAt");

-- CreateIndex
CREATE INDEX "DocumentPublication_provider_state_nextAttemptAt_idx" ON "DocumentPublication"("provider", "state", "nextAttemptAt");

COMMIT;
