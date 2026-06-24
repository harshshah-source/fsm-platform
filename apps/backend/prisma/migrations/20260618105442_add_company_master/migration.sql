-- CreateEnum
CREATE TYPE "company_tier" AS ENUM ('PLATINUM', 'GOLD', 'SILVER');

-- CreateTable
CREATE TABLE "company_master" (
    "company_id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "company_tier" "company_tier" NOT NULL,
    "company_priority_rank" TEXT NOT NULL,
    "contract_ref" TEXT,
    "source" TEXT,
    "ops_override" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "company_master_pkey" PRIMARY KEY ("company_id")
);

-- CreateIndex
CREATE INDEX "company_master_company_tier_company_priority_rank_idx" ON "company_master"("company_tier", "company_priority_rank");
