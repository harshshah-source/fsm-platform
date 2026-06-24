-- CreateTable
CREATE TABLE "ticket_events" (
    "event_id" BIGSERIAL NOT NULL,
    "ticket_id" UUID NOT NULL,
    "from_state" TEXT,
    "to_state" TEXT NOT NULL,
    "actor_id" UUID,
    "actor_role" "role",
    "acted_as_role" "role",
    "reason_code" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "ticket_events_ticket_id_at_idx" ON "ticket_events"("ticket_id", "at");

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;
