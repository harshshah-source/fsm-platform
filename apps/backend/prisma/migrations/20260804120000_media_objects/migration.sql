-- Issue 81 (D-12, settled 2026-08-03) — the Media Upload API's storage seam. Photo bytes live in
-- this Postgres database for the pilot (planned move to a separate media instance before rollout,
-- deferred pending #111 deployment packaging). The `media_id` primary key is the opaque `photoRef`
-- the mobile client receives; nothing about storage location is exposed in that id.
--
-- Slots (#172 Decision 6) are carried from day one: TROUBLESHOOT has 4 named slots, VOUCHER has 3,
-- INSTALL has 1. This is the irreversible part of the contract -- retrofitting slots onto a shipped
-- flat `photoRef` array would break every photo screen on every already-installed handset (#170
-- no-OTA for the pilot).

CREATE TYPE "media_kind" AS ENUM ('TROUBLESHOOT', 'VOUCHER', 'INSTALL');
CREATE TYPE "media_slot" AS ENUM ('BEFORE', 'AFTER', 'PART', 'PLATE', 'RECEIPT', 'PHOTO', 'BILL', 'INSTALL_PHOTO');

CREATE TABLE "media_objects" (
  "media_id"     UUID           NOT NULL DEFAULT gen_random_uuid(),
  "se_id"        UUID           NOT NULL,
  "kind"         "media_kind"   NOT NULL,
  "slot"         "media_slot"   NOT NULL,
  "content_type" TEXT           NOT NULL,
  "size_bytes"   INTEGER        NOT NULL,
  "bytes"        BYTEA          NOT NULL,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_objects_pkey" PRIMARY KEY ("media_id")
);

CREATE INDEX "media_objects_se_id_idx" ON "media_objects" ("se_id");

ALTER TABLE "media_objects"
  ADD CONSTRAINT "media_objects_se_id_fkey"
  FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
