-- CreateEnum
CREATE TYPE "snapshot_status" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "chunk_status" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "snapshot_runs" (
    "run_id" BIGSERIAL NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "status" "snapshot_status" NOT NULL DEFAULT 'RUNNING',
    "cursor" TEXT,
    "data_as_of" TIMESTAMPTZ(6),
    "chunk_stats" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "snapshot_runs_pkey" PRIMARY KEY ("run_id")
);

-- CreateTable
CREATE TABLE "snapshot_run_chunks" (
    "id" BIGSERIAL NOT NULL,
    "run_id" BIGINT NOT NULL,
    "chunk_no" INTEGER NOT NULL,
    "status" "chunk_status" NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "snapshot_run_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable (range-partitioned by gps_datetime — hand-written; Prisma cannot express PARTITION BY).
-- The partition key (gps_datetime) must be part of the PK and of every UNIQUE index.
CREATE TABLE "raw_device_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "run_id" BIGINT NOT NULL,
    "device_id" BIGINT NOT NULL,
    "gps_datetime" TIMESTAMPTZ(6) NOT NULL,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "mains_status" SMALLINT,
    "mains_voltage" DECIMAL(12,2),
    "gps_validity" TEXT,
    "gps_mode" TEXT,
    "ignition_status" TEXT,
    "speed" DECIMAL(12,2),
    "creg" TEXT,
    "cgreg" TEXT,
    "csq" SMALLINT,
    "ip_address" INET,
    "port_no" INTEGER,
    "sim_subscriber_name" TEXT,
    "unit_no" TEXT,
    "device_type" TEXT,

    CONSTRAINT "raw_device_snapshots_pkey" PRIMARY KEY ("id", "gps_datetime")
) PARTITION BY RANGE ("gps_datetime");

-- DEFAULT partition so every ingested ping always lands somewhere. Monthly child partitions +
-- detach/archive are a later slice (ArchiveExportWorker); rows belonging to a future named month
-- partition can be migrated out of DEFAULT when that partition is created.
CREATE TABLE "raw_device_snapshots_default" PARTITION OF "raw_device_snapshots" DEFAULT;

-- CreateIndex: single in-flight run guard (partial UNIQUE — raw SQL, like the se_coverage CHECK).
CREATE UNIQUE INDEX "snapshot_runs_one_in_flight" ON "snapshot_runs" ("status") WHERE "status" = 'RUNNING';

-- CreateIndex
CREATE UNIQUE INDEX "snapshot_run_chunks_run_id_chunk_no_key" ON "snapshot_run_chunks"("run_id", "chunk_no");

-- CreateIndex
CREATE INDEX "snapshot_run_chunks_run_id_status_idx" ON "snapshot_run_chunks"("run_id", "status");

-- CreateIndex: chunk re-run idempotency (UNIQUE must include the partition key).
CREATE UNIQUE INDEX "raw_device_snapshots_device_id_gps_datetime_key" ON "raw_device_snapshots"("device_id", "gps_datetime");

-- CreateIndex: hot path for verification + latest-ping lookup.
CREATE INDEX "raw_device_snapshots_device_id_gps_datetime_idx" ON "raw_device_snapshots"("device_id", "gps_datetime" DESC);

-- AddForeignKey
ALTER TABLE "snapshot_run_chunks" ADD CONSTRAINT "snapshot_run_chunks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "snapshot_runs"("run_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_device_snapshots" ADD CONSTRAINT "raw_device_snapshots_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "snapshot_runs"("run_id") ON DELETE RESTRICT ON UPDATE CASCADE;
