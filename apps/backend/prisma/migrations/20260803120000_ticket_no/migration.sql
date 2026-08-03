-- Issue 161 D-4 — human-readable ticket number (`TCK-#####`), additive alongside the UUID
-- `ticket_id` primary key. `ticket_id` stays canonical identity and the API route param;
-- `ticket_no` is a display label only, chronologically monotonic (backfilled in creation order,
-- per the issue's own Backfill section) so an SE reading two numbers can tell which ticket is
-- older. The client formats `TCK-` + zero-padded-to-5; the server returns the raw integer.
--
-- The column is added nullable, with no default, so the backfill below controls value order
-- deliberately -- an eager `DEFAULT nextval(...)` on ADD COLUMN would number existing rows in
-- physical heap order, not `created_at` order, which is the actual requirement.
ALTER TABLE "tickets" ADD COLUMN "ticket_no" BIGINT;

-- Backfill in creation order (ORDER BY created_at ASC, ticket_id ASC — ticket_id as the tiebreak
-- for rows sharing a created_at timestamp, so the ordering is total and deterministic). Postgres
-- DDL + DML inside one migration file runs in a single transaction under `prisma migrate deploy`,
-- so this is already all-or-nothing at the ~21k-row scale the issue cites: a half-backfilled table
-- with a live sequence (the failure mode the issue calls out) cannot happen -- either every row
-- gets numbered and the sequence is created, or the whole migration rolls back. No batching/resume
-- logic is needed at this scale.
WITH ordered AS (
  SELECT "ticket_id", ROW_NUMBER() OVER (ORDER BY "created_at" ASC, "ticket_id" ASC) AS rn
  FROM "tickets"
  WHERE "ticket_no" IS NULL
)
UPDATE "tickets" t SET "ticket_no" = ordered.rn
FROM ordered
WHERE t."ticket_id" = ordered."ticket_id";

-- Sequence starts strictly above the backfilled maximum so the next INSERT continues the same
-- monotonic order; OWNED BY the column so it is dropped automatically if the column ever is.
CREATE SEQUENCE "tickets_ticket_no_seq";
SELECT setval('tickets_ticket_no_seq', COALESCE((SELECT MAX("ticket_no") FROM "tickets"), 0) + 1, false);
ALTER TABLE "tickets" ALTER COLUMN "ticket_no" SET DEFAULT nextval('tickets_ticket_no_seq');
ALTER SEQUENCE "tickets_ticket_no_seq" OWNED BY "tickets"."ticket_no";

ALTER TABLE "tickets" ALTER COLUMN "ticket_no" SET NOT NULL;
CREATE UNIQUE INDEX "tickets_ticket_no_key" ON "tickets"("ticket_no");
