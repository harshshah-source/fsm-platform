-- #264 — durable day-plan notification outbox (executes #189). A committed dispatch/override can
-- never lose its "Day Plan is live/updated" notification to a crash, and a notification failure can
-- never make a successful dispatch/override look failed.
CREATE TABLE "day_plan_notification_outbox" (
  "id"          BIGSERIAL PRIMARY KEY,
  "event_type"  TEXT NOT NULL,
  "se_id"       UUID NOT NULL,
  "schedule_id" BIGINT NOT NULL,
  "zone_id"     BIGINT,
  "payload"     JSONB NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "sent_at"     TIMESTAMPTZ(6),
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "last_error"  TEXT
);

-- Not expressible in the Prisma schema DSL (partial index) — see schema.prisma's model comment. The
-- re-drain sweep's whole query is "unsent rows"; this is what keeps that a lookup, not a seq scan.
CREATE INDEX "day_plan_notification_outbox_unsent_idx"
  ON "day_plan_notification_outbox" ("created_at")
  WHERE "sent_at" IS NULL;
