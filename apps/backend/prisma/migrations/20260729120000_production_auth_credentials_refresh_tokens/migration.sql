-- Issue 91, Slice 1 — production authentication storage: `user_credentials` + `refresh_tokens`.
--
-- Replaces the two process-local stores the login path has been running on (`InMemoryUserStore`,
-- `InMemoryRefreshTokenStore`). Consequences of the old shape, for the record: exactly one SE account
-- existed fleet-wide, every deploy logged out every session, refresh records were never reclaimed, and
-- a second app instance was impossible because neither store was shared.
--
-- CREDENTIAL PLACEMENT (operator decision, 2026-07-28): a dedicated table, NOT columns on `users`.
-- `users` is the Operations-Head-managed account registry read by GET /api/org/users, the admin
-- surfaces and #121's raw-data export; keeping password material out of it means a future widened
-- SELECT cannot leak a hash into a response or a CSV. Costs one join on login, which is not a hot
-- path and is throttled by #110 anyway. This also preserves the intent the schema already stated.
--
-- DEVICE BINDING (operator decision D-2, 2026-07-28): `refresh_tokens.device_id` ships NOW even though
-- the launch policy is ONE ACTIVE DEVICE, replace-on-login. Max-devices is a count-at-login query, not
-- a table shape, so raising it to 2 or N later is a config change that logs nobody out. Shipping
-- without this column is what would force a migration AND a fleet-wide re-login, because existing rows
-- would carry no device attribution and could only be resolved by invalidating them.

CREATE TABLE "user_credentials" (
  "user_id"         UUID           NOT NULL,
  "password_hash"   TEXT           NOT NULL,
  "password_salt"   TEXT           NOT NULL,
  "password_algo"   TEXT           NOT NULL DEFAULT 'scrypt',
  -- scrypt cost params as {N, r, p, keylen}. Stored per row so a future parameter bump can re-hash
  -- lazily on next successful login rather than forcing a big-bang re-credential of every account.
  "password_params" JSONB,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "user_credentials_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "user_credentials"
  ADD CONSTRAINT "user_credentials_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "refresh_tokens" (
  "id"             BIGSERIAL      NOT NULL,
  "user_id"        UUID           NOT NULL,
  -- Only the hash is stored; the plaintext is returned to the client once and never persisted, so a
  -- database read can never yield a usable token.
  "token_hash"     TEXT           NOT NULL,
  -- Opaque install id supplied by the client (`X-Device-Id`). See D-2 note in the header.
  "device_id"      TEXT           NOT NULL,
  "device_label"   TEXT,
  "issued_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"     TIMESTAMPTZ(6) NOT NULL,
  "revoked_at"     TIMESTAMPTZ(6),
  -- ROTATED · REPLACED_BY_NEW_DEVICE · LOGOUT · REUSE_DETECTED · ADMIN_REVOKE. Free text rather than
  -- an enum so answering a new support question never needs a migration.
  "revoked_reason" TEXT,
  "last_seen_at"   TIMESTAMPTZ(6),
  -- Rotation lineage: what makes reuse detection possible, and the hook for a future rotation grace
  -- window (today a dropped refresh RESPONSE on a lossy field network burns the session permanently).
  "rotated_from"   BIGINT,
  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens" ("token_hash");

-- Serves the one-active revoke-previous-sessions write, and any future device-list read.
CREATE INDEX "refresh_tokens_user_id_revoked_at_idx" ON "refresh_tokens" ("user_id", "revoked_at");

-- Serves expired-row reclamation. The in-memory store never reclaimed anything — that was the leak.
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens" ("expires_at");

ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
