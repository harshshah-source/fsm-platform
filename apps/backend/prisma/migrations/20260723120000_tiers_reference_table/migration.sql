-- Issue 157, Slice 1 — tiers reference table (order as data, additive / non-breaking).
-- Canonical tier list + rank, seeded from the PRD canon (CONTEXT.md:315, Decision §17 :765:
-- Platinum > Gold > Silver). rank 1 = highest priority, matching the spec's prose direction.
-- Read by admin dropdowns and a spec-pin test asserting tiers <-> the company_tier enum <->
-- the recommender's TIER_ORDER array agree, retiring the reversed-array footgun
-- (canonical-sort.ts:30) as a caught drift rather than a silent one.

CREATE TABLE "tiers" (
  "name" TEXT NOT NULL,
  "rank" INTEGER NOT NULL,
  CONSTRAINT "tiers_pkey" PRIMARY KEY ("name")
);
CREATE UNIQUE INDEX "tiers_rank_key" ON "tiers"("rank");

INSERT INTO "tiers" ("name", "rank") VALUES
  ('PLATINUM', 1),
  ('GOLD', 2),
  ('SILVER', 3);
