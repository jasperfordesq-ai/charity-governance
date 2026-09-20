-- Which record an approval is about.
--
-- The summary a person reads before typing their password was built from the
-- route pattern alone: "Permanently delete: board members (DELETE)". Which
-- board member was not stated, so the person was approving on the agent's
-- word. The identifier is stored here, beside a summary that now names the
-- record, and is returned in the refusal and the approval preview.
--
-- Nullable and additive. Rows minted before this column exist and are simply
-- about a record nobody wrote down.
ALTER TABLE "AuthActionApproval"
    ADD COLUMN "resourceId" TEXT;
