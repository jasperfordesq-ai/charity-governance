-- A record of what a non-browser client did, kept separately from the security
-- audit trail.
--
-- SecurityAuditEvent answers "who changed this person's access, and why". It is
-- written deliberately, by a handful of lifecycle operations, and roughly forty
-- of the API's fifty-five mutating routes write no row at all. That is tolerable
-- while every write comes from a human in a browser, because the browser session
-- is the human.
--
-- It stops being tolerable the moment an agent holds a credential. This table
-- answers a different question: "what did that client actually do". It is
-- written by a hook rather than by each route, so a route added later is covered
-- without anyone remembering, and it records attempts as well as successes,
-- because a refused write is the row most worth reading.
--
-- Append-only for the same reason the audit trail is: a record the acting party
-- can edit afterwards is not a record. The trigger is modelled on
-- SecurityAuditEvent_append_only and rejects UPDATE and DELETE alike.
--
-- Every column is declared not-null at creation, so none of the blue-green
-- gate's blocked alterations appear here; a new table needs none of them.
BEGIN;

-- CreateTable
CREATE TABLE "ClientActivityEvent" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- Not a foreign key to "AuthSession". Sessions rotate on every refresh and
    -- are deleted when they expire; the record of what a client did must outlive
    -- the session that did it.
    "sessionId" TEXT NOT NULL,
    "clientKind" "AuthSessionClientKind" NOT NULL,
    "accessLevel" "AuthSessionAccessLevel" NOT NULL,
    "method" TEXT NOT NULL,
    -- The matched route pattern, not the requested path: "/board-members/:id"
    -- rather than an identifier that would turn this column into a second,
    -- unindexed copy of the data it describes.
    "routePattern" TEXT NOT NULL,
    "resourceId" TEXT,
    "statusCode" INTEGER NOT NULL,
    "requestId" TEXT,
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientActivityEvent_id_organisationId_key"
    ON "ClientActivityEvent"("id", "organisationId");

-- CreateIndex
CREATE INDEX "ClientActivityEvent_organisationId_occurredAt_id_idx"
    ON "ClientActivityEvent"("organisationId", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "ClientActivityEvent_organisationId_sessionId_occurredAt_idx"
    ON "ClientActivityEvent"("organisationId", "sessionId", "occurredAt");

-- AddForeignKey
ALTER TABLE "ClientActivityEvent"
    ADD CONSTRAINT "ClientActivityEvent_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
-- Composite, matching the audit table: a row cannot name a user belonging to a
-- different charity than the row itself.
ALTER TABLE "ClientActivityEvent"
    ADD CONSTRAINT "ClientActivityEvent_userId_organisationId_fkey"
    FOREIGN KEY ("userId", "organisationId") REFERENCES "User"("id", "organisationId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A status code outside the HTTP range means the hook recorded something it did
-- not understand, which is worth failing on rather than storing.
ALTER TABLE "ClientActivityEvent"
    ADD CONSTRAINT "ClientActivityEvent_statusCode_check"
    CHECK ("statusCode" BETWEEN 100 AND 599);

CREATE FUNCTION "reject_client_activity_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Client activity events are append-only'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "ClientActivityEvent_append_only"
    BEFORE UPDATE OR DELETE ON "ClientActivityEvent"
    FOR EACH ROW EXECUTE FUNCTION "reject_client_activity_mutation"();

COMMIT;
