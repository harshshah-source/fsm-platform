-- Issue 10, slice 1 — recommendations (Recommender explainability record, LLD §3.6, ADR-0003/0017).
-- Append-only: corrections create new rows.

CREATE TYPE "rec_path" AS ENUM ('MORNING_BATCH', 'INTRADAY');

CREATE TABLE "recommendations" (
    "recommendation_id" BIGSERIAL NOT NULL,
    "ticket_id" UUID NOT NULL,
    "se_id" UUID,
    "company_tier" "company_tier",
    "device_bucket" "sla_bucket",
    "score_breakdown" JSONB NOT NULL,
    "processing_rank" INTEGER,
    "status" TEXT NOT NULL,
    "path" "rec_path" NOT NULL,
    "retry_chain" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("recommendation_id")
);

CREATE INDEX "recommendations_ticket_id_idx" ON "recommendations"("ticket_id");
CREATE INDEX "recommendations_se_id_idx" ON "recommendations"("se_id");

ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_se_id_fkey"
    FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
