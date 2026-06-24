-- Issue 12, slice 2 — Shared Pool query index (LLD §3 tickets). Per-plant lookup of "secondary open
-- work": OPEN tickets not yet a Formal Assignment. Partial index — not expressible in Prisma.

CREATE INDEX "tickets_shared_pool_idx" ON "tickets"("plant_id")
    WHERE "status" = 'OPEN' AND "assignment_state" = 'UNASSIGNED';
