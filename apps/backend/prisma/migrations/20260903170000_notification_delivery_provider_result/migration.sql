-- #337 — record what the provider actually said about a push, not only that we tried.
--
-- `notification_deliveries` exists so somebody can afterwards ask "was this person actually told?"
-- and get a truthful answer. Until now the only answer it could give was a status, which was enough
-- while the gateway was inert and every external row was ATTEMPTED for the same single reason ("no
-- adapter"). With a real FCM exit there are several different failures behind one FAILED — a stale
-- token that was reaped, a 5xx the provider will recover from, a credential the operator has to fix
-- — and the difference decides who has to do something about it.
--
-- `provider_message_id` is the handle FCM answers to: it is what an operator quotes when they have
-- to ask the provider what became of one specific push. `error` is the sentence that says why a
-- FAILED row failed.
--
-- Both nullable and additive: every existing row keeps its meaning (IN_APP never leaves the building
-- and the inert logging gateway has nothing to report, so both stay NULL for them), no backfill is
-- possible or wanted, and the columns are inert until PUSH_PROVIDER names a real provider.

ALTER TABLE "notification_deliveries" ADD COLUMN "provider_message_id" TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN "error" TEXT;
