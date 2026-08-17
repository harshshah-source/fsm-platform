-- #238 — SE-assignment threshold governance.
--
-- Two things land here, both in service of "the threshold of when an SE is assigned is configurable,
-- OH and CSM both hold the authority, and the OH has the final decision":
--
--  1. `system_settings` gains a LOCK. A locked key refuses every writer except OPERATIONS_HEAD. That
--     is the mechanism behind "final decision" — the CSM tunes day to day, and the OH can take the
--     key back at any moment without a deploy, a role change, or a data edit.
--  2. `setting_changes` — the append-only value history. `audit_logs` already records THAT a setting
--     changed, but its metadata carries no previous value, so it can neither answer "what was this
--     before Tuesday" nor back a revert. This table is that answer, and the row a REVERT points at.
--
-- Nothing here is destructive: the lock columns are nullable (existing rows read as unlocked) and
-- the history table starts empty (a key with no rows simply has no recorded trail yet).

ALTER TABLE "system_settings"
  ADD COLUMN "locked_at"      TIMESTAMPTZ(6),
  ADD COLUMN "locked_by"      TEXT,
  ADD COLUMN "locked_by_role" TEXT,
  ADD COLUMN "lock_reason"    TEXT;

CREATE TYPE "setting_change_type" AS ENUM ('SET', 'REVERT', 'LOCK', 'UNLOCK');

CREATE TABLE "setting_changes" (
  "id"               BIGSERIAL             NOT NULL,
  "key"              TEXT                  NOT NULL,
  "previous_value"   JSONB,
  "new_value"        JSONB,
  "change_type"      "setting_change_type" NOT NULL,
  "actor_id"         TEXT                  NOT NULL,
  "actor_role"       TEXT                  NOT NULL,
  "reason"           TEXT,
  "reverted_from_id" BIGINT,
  "created_at"       TIMESTAMPTZ(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "setting_changes_pkey" PRIMARY KEY ("id")
);

-- Serves the per-key history read (newest first) that backs the settings UI and the revert picker.
CREATE INDEX "setting_changes_key_created_at_idx" ON "setting_changes" ("key", "created_at");

-- ON DELETE CASCADE: a key removed from the registry takes its trail with it. Settings keys are
-- seeded, never deleted in practice, so this is a tidiness guarantee rather than a live path.
ALTER TABLE "setting_changes"
  ADD CONSTRAINT "setting_changes_key_fkey"
  FOREIGN KEY ("key") REFERENCES "system_settings"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- Dispatch-ledger transparency for the new gate. `withheld_below_threshold` is counted apart from
-- `unassignable` deliberately: unassignable means the engine looked and found nobody (a coverage or
-- capacity failure somebody must act on), withheld means it deliberately did not look yet (the
-- configured policy working). Folded together, every threshold increase would read on the ledger as a
-- fleet-wide dispatch outage. Defaults are 0/NULL, so runs recorded before this migration stay honest
-- — they have no withheld figure because no threshold gate existed when they ran.
ALTER TABLE "dispatch_runs"
  ADD COLUMN "withheld_below_threshold" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "dispatch_run_zones"
  ADD COLUMN "withheld_below_threshold"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "assignment_threshold_hours" INTEGER;
