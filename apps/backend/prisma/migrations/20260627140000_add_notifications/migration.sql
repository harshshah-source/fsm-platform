-- Issue 03 — Notification spine. The cross-cutting in-app notification + multi-channel delivery record.
-- Every notifiable event ALWAYS writes an in-app `notifications` row (per recipient, per role); each
-- delivery attempt (in-app + the push→SMS→WhatsApp→email fallback chain, and the first-class WhatsApp
-- Confirmation for SE-Acceptance) is recorded in `notification_deliveries`. External channel adapters
-- (FCM/APNs/WhatsApp/SMS/SMTP) are a deferred seam (HITL account setup) — the chain + status recording is
-- the internal spine.

CREATE TYPE "notification_channel" AS ENUM ('IN_APP', 'PUSH', 'SMS', 'WHATSAPP', 'EMAIL');
CREATE TYPE "notification_delivery_status" AS ENUM ('SENT', 'ATTEMPTED', 'SKIPPED', 'FAILED');

CREATE TABLE "notifications" (
  "id"                BIGSERIAL      NOT NULL,
  "recipient_user_id" UUID           NOT NULL,
  "recipient_role"    "role"         NOT NULL,
  "type"              TEXT           NOT NULL,
  "entity_type"       TEXT,
  "entity_id"         TEXT,
  "title"             TEXT           NOT NULL,
  "body"              TEXT,
  "metadata"          JSONB,
  "in_app_read_at"    TIMESTAMPTZ(6),
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notifications_recipient_created_idx" ON "notifications" ("recipient_user_id", "created_at" DESC);
CREATE INDEX "notifications_recipient_unread_idx" ON "notifications" ("recipient_user_id", "in_app_read_at");

CREATE TABLE "notification_deliveries" (
  "id"              BIGSERIAL                     NOT NULL,
  "notification_id" BIGINT                        NOT NULL,
  "channel"         "notification_channel"        NOT NULL,
  "status"          "notification_delivery_status" NOT NULL,
  "first_class"     BOOLEAN                       NOT NULL DEFAULT false,
  "created_at"      TIMESTAMPTZ(6)                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_deliveries_notification_id_fkey"
    FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "notification_deliveries_notification_idx" ON "notification_deliveries" ("notification_id");
