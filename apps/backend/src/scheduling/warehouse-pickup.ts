import type { DayPlanPickupPart, DayPlanWarehousePickupStop } from '@fsm/shared';
import type { PrismaService } from '../prisma/prisma.service';

export type { DayPlanPickupPart, DayPlanWarehousePickupStop } from '@fsm/shared';

/**
 * #366 — the Zone Warehouse pickup stop, in one place, for the two reads that show a day plan:
 * the SE's own (`DayPlanQueryService`) and the manager's schedule detail (`ZmScheduleQueryService`).
 * One definition for the same reason `liveBatchFilter` and `committedDayLoad` are shared — the
 * dispatcher checking the plan and the engineer working it must be told the same thing.
 *
 * **It is derived at read time, and that is the design, not an economy.** The survey's plan asked
 * for a pickup flag or row persisted on the schedule; a stored flag would be wrong within hours in
 * both directions. The approved design says stop 0 appears "only when it is real", and *real* is a
 * present-tense fact about the parts: a request shipped after this morning's dispatch has to appear
 * on the plan, and the moment the SE confirms receipt the stop has to go, because there is nothing
 * left to collect. Only a read can track that. Nothing about the dispatch write path changes.
 *
 * **`status = 'SHIPPED'` is exactly "shipped and not yet received"** — the lifecycle is
 * REQUESTED → APPROVED | REJECTED → SHIPPED → RECEIVED (`component-request.service.ts`), so
 * confirming receipt moves the row out of SHIPPED rather than stamping a flag beside it.
 *
 * Deliberately **not** filtered by `delivery_destination`: that enum is `SE_LOCATION |
 * PLANT_WAREHOUSE` and drives Floating-SE resubmit ownership (ADR-0008), not where the SE collects.
 * Filtering on it would make this feature dead for every request ever written.
 */

/** The pickup's fixed position: before stop 1, because stop 1 cannot be worked without the part. */
export const WAREHOUSE_PICKUP_STOP_SEQUENCE = 0;

/**
 * The zone's warehouse has no row of its own — `zone_warehouse_stock` is keyed by zone alone — so
 * the zone *is* the warehouse and its name is derived rather than stored. Named here so both reads
 * (and any later mobile screen) say the same words.
 */
export function zoneWarehouseName(zoneName: string): string {
  return `${zoneName} Zone Warehouse`;
}

/**
 * The single pickup stop for a plan, or `null` when nothing is waiting.
 *
 * `ticketIds` are the plan's *live* tickets — the caller has already applied the hollow-stop and
 * `removedAt` rules, so a part for a ticket that was removed from the plan this morning does not
 * send the engineer to the warehouse for it.
 *
 * One stop however many parts: an engineer makes a single warehouse visit. The parts are ordered
 * oldest request first, so the part that has been waiting longest reads first.
 */
export async function warehousePickupStop(
  prisma: PrismaService,
  args: { ticketIds: string[]; zoneName: string },
): Promise<DayPlanWarehousePickupStop | null> {
  if (args.ticketIds.length === 0) return null;

  const requests = await prisma.componentRequest.findMany({
    where: { ticketId: { in: args.ticketIds }, status: 'SHIPPED' },
    orderBy: [{ createdAt: 'asc' }, { requestId: 'asc' }],
    select: {
      requestId: true,
      ticketId: true,
      componentId: true,
      trackingRef: true,
      component: { select: { name: true } },
    },
  });
  // Never an empty pickup stop — a row saying "collect nothing" is worse than no row.
  if (requests.length === 0) return null;

  const parts: DayPlanPickupPart[] = requests.map((r) => ({
    requestId: r.requestId,
    ticketId: r.ticketId,
    componentId: r.componentId === null ? null : String(r.componentId),
    componentName: r.component?.name ?? null,
    trackingRef: r.trackingRef,
  }));

  return {
    kind: 'WAREHOUSE_PICKUP',
    stopSequence: WAREHOUSE_PICKUP_STOP_SEQUENCE,
    warehouseName: zoneWarehouseName(args.zoneName),
    parts,
  };
}
