-- #130 L1 — build-fingerprint version lock (pure offline DDL; no network I/O, no AutoPlant).
-- Single enforced row: the database's build high-water mark. `assertBuildNotStale` reads/writes
-- this row under pg_advisory_xact_lock at every entrypoint's onModuleInit so a build older than the
-- mark cannot start or write (the exact 2026-07-19 run-65 stale-code process this closes).
CREATE TABLE "runtime_lock" (
  "id"             INTEGER      PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  -- Monotonic key = git committer epoch (`git show -s --format=%ct`). Newer commit ⇒ larger.
  "version"        BIGINT       NOT NULL,
  -- Commit SHA that owns the mark; a `-dirty` suffix marks a build made from a dirty worktree.
  "fingerprint"    TEXT         NOT NULL,
  "app_version"    TEXT,
  "migration_head" TEXT,
  "boot_at"        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "pid"            INTEGER,
  "hostname"       TEXT,
  "updated_at"     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
