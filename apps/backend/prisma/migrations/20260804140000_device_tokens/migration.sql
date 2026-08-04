-- Issue 76 (D1/D4 settled 2026-08-03) -- push device-token registry, the mobile push client (#89)
-- depends on. One row per user (D4, matches #91's one-active-device policy), not per device -- a
-- new registration replaces the prior row. platform defaults FCM (D1 -- Android-only for v1).
CREATE TABLE "device_tokens" (
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'FCM',
    "device_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
