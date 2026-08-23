-- #263 — the cron tick claim. "Is a scheduler enabled here?" stops being a correctness precondition.
--
-- Before this, every `@Cron` in the app fired wherever `BUSINESS_SWEEPS_ENABLED` /
-- `INGESTION_SCHEDULER_ENABLED` was truthy, and the guards that stop a tick overlapping its own
-- successor were process-local (a `Set` on a singleton, a boolean field). Two enabled instances ran
-- every sweep twice: report cubes racing delete-then-insert, doubled notification sends, duplicate
-- dispatch runs degraded to LOCK_CONTENDED noise. The row below is the arbitration — one winner per
-- (job, minute), decided by the database rather than by an ops flag being set on exactly one machine
-- (#258 Q8.7 / G6).
--
-- `window_start` is the fire instant truncated to its UTC minute. Two instances never fire at the same
-- millisecond, so the claim has to key on a bucket; a minute is the finest one that cannot split a
-- single logical fire and the coarsest that cannot merge two. No timezone: `timeZone` pinning (#240)
-- decides *when* a job fires, and by the time it has fired only the instant remains.

CREATE TABLE "cron_tick_claims" (
  "job_name"     TEXT NOT NULL,
  "window_start" TIMESTAMPTZ(3) NOT NULL,
  -- Diagnosis only, never a predicate: hostname/pid plus the #130 build fingerprint, so a log line
  -- saying "already claimed by …" identifies the machine AND the build — the part that matters when
  -- two instances disagree because one of them is mid-deploy.
  "claimed_by"   TEXT NOT NULL,
  "claimed_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

  -- The composite primary key IS the arbitration. It is what makes `INSERT … ON CONFLICT DO NOTHING`
  -- a correct admission test rather than a check-then-act race, and it is the only index the claim
  -- path touches — one indexed statement per tick.
  CONSTRAINT "cron_tick_claims_pkey" PRIMARY KEY ("job_name", "window_start")
);

-- Retention only. The claim path never reads by window alone; this exists so the daily prune is a
-- range scan over a week-old boundary instead of a sequential scan of an append-only table. Left off
-- `claimed_at` deliberately — `window_start` is derived, identical on every instance, and therefore
-- the one column whose ordering cannot be perturbed by clock skew between the machines writing here.
CREATE INDEX "ix_cron_tick_claims_window_start" ON "cron_tick_claims" ("window_start");
