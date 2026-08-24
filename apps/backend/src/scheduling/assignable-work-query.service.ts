import { Injectable } from '@nestjs/common';
import { istDate } from '../common/ist-day';
import { isCriticalPlus } from '../device-state/sla-bucket';
import { PrismaService } from '../prisma/prisma.service';
import { assignableTickets, heldTickets } from '../ticketing/assignable-work';
import type { ZmScope } from './zm-schedule-query.service';

/** One site's outstanding work, for one company. */
export interface AssignablePlantRow {
  plantId: string;
  plantName: string;
  zoneId: string;
  /** Tickets a manual assign would move **right now** — the same set the write commits. */
  openUnassigned: number;
  /** Devices at the site for this company, from `device_states` — the denominator, not a work count. */
  totalDevices: number;
  /** How much of `openUnassigned` sits in a CRITICAL+ SLA bucket. */
  criticalCount: number;
  /** The longest any assignable ticket's device has been silent, in hours; null when unmeasured. */
  oldestInactivityHours: number | null;
  /** Open, unassigned, but deliberately held to a future date (#146/#246) — excluded from the above. */
  heldCount: number;
}

export interface AssignableCompanyGroup {
  companyId: string;
  companyName: string;
  plants: AssignablePlantRow[];
}

export interface AssignableWorkView {
  /** The IST operating day the counts are for — the same day the commit will be judged against. */
  date: string;
  totals: { openUnassigned: number; criticalCount: number; heldCount: number; plants: number };
  companies: AssignableCompanyGroup[];
}

/** Aggregation key: a plant serves several companies, so neither id alone identifies a row. */
const key = (companyId: bigint | string, plantId: bigint | string) => `${companyId}:${plantId}`;

/**
 * The Assign Work Console's work pool (#273, decisions #272 **R1** and **R3**).
 *
 * Answers, before anything is written, the question every manual surface in this codebase failed to:
 * **how much unassigned work is there, and where?** The seven pre-existing assign surfaces each moved
 * work without ever showing a count, so the volume only arrived afterwards, in a toast.
 *
 * **Grouped by (company, plant), not by plant.** `plants` carries no `company_id` — several companies'
 * vehicles sit at one site — so the company comes off the *ticket*, and the same plant legitimately
 * appears under more than one company. Collapsing to the plant would silently merge two companies'
 * work behind one checkbox, and the tier that decides dispatch priority is a *company* attribute.
 *
 * **Counted in memory from the shared predicate, not in SQL.** A `GROUP BY` would be cheaper and would
 * be a *second* spelling of {@link assignableTickets} — exactly the fork R3 exists to close, and the
 * one this console cannot afford, since the count sits next to the button that acts on it. Sharing the
 * Prisma predicate with `assignPlants` is what makes the read predict the write; the row volume is
 * bounded by the zone's open backlog and is small beside what the recommender already loads per run.
 *
 * A (company, plant) pair appears when it has **either** assignable or held work: a site whose only
 * outstanding work is held must still be visible, or the operator sees nothing and concludes there is
 * nothing there.
 */
@Injectable()
export class AssignableWorkQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async listForScope(scope: ZmScope, now: Date = new Date()): Promise<AssignableWorkView> {
    const day = istDate(now);
    const plantClamp = this.zoneClamp(scope);

    const open = await this.prisma.ticket.findMany({
      where: { ...assignableTickets(day), ...(plantClamp ? { plant: plantClamp } : {}) },
      select: {
        companyId: true,
        plantId: true,
        device: { select: { state: { select: { slaBucket: true, inactivityHours: true } } } },
      },
    });

    const held = await this.prisma.ticket.groupBy({
      by: ['companyId', 'plantId'],
      where: { ...heldTickets(day), ...(plantClamp ? { plant: plantClamp } : {}) },
      _count: { _all: true },
    });

    type Acc = { openUnassigned: number; criticalCount: number; oldest: number | null; heldCount: number };
    const acc = new Map<string, Acc>();
    const at = (companyId: bigint, plantId: bigint): Acc =>
      acc.get(key(companyId, plantId)) ??
      acc.set(key(companyId, plantId), { openUnassigned: 0, criticalCount: 0, oldest: null, heldCount: 0 }).get(
        key(companyId, plantId),
      )!;

    for (const t of open) {
      const row = at(t.companyId, t.plantId);
      row.openUnassigned += 1;
      const state = t.device.state;
      if (state?.slaBucket && isCriticalPlus(state.slaBucket)) row.criticalCount += 1;
      // `inactivity_hours` is a nullable `Decimal` — a device whose state has never been recomputed
      // reports no age rather than 0, which would read as "just now" on the very row that most needs
      // attention. `Number()` because Prisma hands back a Decimal object, which `Math.max` would
      // coerce to NaN and silently poison every row at the plant.
      const hours = state?.inactivityHours == null ? null : Number(state.inactivityHours);
      if (hours !== null && Number.isFinite(hours)) {
        row.oldest = row.oldest === null ? hours : Math.max(row.oldest, hours);
      }
    }
    for (const h of held) at(h.companyId, h.plantId).heldCount = h._count._all;

    return this.shape(acc, day);
  }

  /**
   * Resolve names and device totals for the pairs that actually have work, then build the tree.
   * Deliberately a second pass: the lookups are keyed on the pairs we ended up with, so a zone with
   * one busy plant does not pay for every plant and company in it.
   */
  private async shape(
    acc: Map<string, { openUnassigned: number; criticalCount: number; oldest: number | null; heldCount: number }>,
    day: Date,
  ): Promise<AssignableWorkView> {
    const pairs = [...acc.keys()].map((k) => {
      const [companyId, plantId] = k.split(':');
      return { companyId: BigInt(companyId), plantId: BigInt(plantId) };
    });
    if (pairs.length === 0) {
      return { date: day.toISOString().slice(0, 10), totals: { openUnassigned: 0, criticalCount: 0, heldCount: 0, plants: 0 }, companies: [] };
    }

    const companyIds = [...new Set(pairs.map((p) => p.companyId))];
    const plantIds = [...new Set(pairs.map((p) => p.plantId))];
    const companies = await this.prisma.company.findMany({
      where: { companyId: { in: companyIds } },
      select: { companyId: true, name: true },
    });
    const plants = await this.prisma.plant.findMany({
      where: { plantId: { in: plantIds } },
      select: { plantId: true, name: true, zoneId: true },
    });
    // The device denominator is per (company, plant) for the same reason the work count is: one site
    // holds several companies' fleets, and "12 of 38" has to mean 38 of *this* company's devices.
    const devices = await this.prisma.deviceState.groupBy({
      by: ['companyId', 'plantId'],
      where: { companyId: { in: companyIds }, plantId: { in: plantIds } },
      _count: { _all: true },
    });

    const companyName = new Map(companies.map((c) => [String(c.companyId), c.name]));
    const plantById = new Map(plants.map((p) => [String(p.plantId), p]));
    const deviceCount = new Map(
      devices
        .filter((d) => d.companyId !== null && d.plantId !== null)
        .map((d) => [key(d.companyId!, d.plantId!), d._count._all]),
    );

    const groups = new Map<string, AssignableCompanyGroup>();
    const totals = { openUnassigned: 0, criticalCount: 0, heldCount: 0, plants: 0 };

    for (const { companyId, plantId } of pairs) {
      const row = acc.get(key(companyId, plantId))!;
      const plant = plantById.get(String(plantId));
      if (!plant) continue; // a ticket whose plant vanished under it — nothing to offer the operator
      let group = groups.get(String(companyId));
      if (!group) {
        group = {
          companyId: String(companyId),
          companyName: companyName.get(String(companyId)) ?? `Company ${companyId}`,
          plants: [],
        };
        groups.set(String(companyId), group);
      }
      group.plants.push({
        plantId: String(plantId),
        plantName: plant.name,
        zoneId: String(plant.zoneId),
        openUnassigned: row.openUnassigned,
        totalDevices: deviceCount.get(key(companyId, plantId)) ?? 0,
        criticalCount: row.criticalCount,
        oldestInactivityHours: row.oldest,
        heldCount: row.heldCount,
      });
      totals.openUnassigned += row.openUnassigned;
      totals.criticalCount += row.criticalCount;
      totals.heldCount += row.heldCount;
      totals.plants += 1;
    }

    // Busiest first, in both dimensions — the operator's eye should land on the work, not on an
    // alphabet. Ties break on name so the order is stable across polls.
    for (const g of groups.values()) {
      g.plants.sort((a, b) => b.openUnassigned - a.openUnassigned || a.plantName.localeCompare(b.plantName));
    }
    const companiesOut = [...groups.values()].sort(
      (a, b) =>
        b.plants.reduce((n, p) => n + p.openUnassigned, 0) - a.plants.reduce((n, p) => n + p.openUnassigned, 0) ||
        a.companyName.localeCompare(b.companyName),
    );

    return { date: day.toISOString().slice(0, 10), totals, companies: companiesOut };
  }

  /**
   * Resolve plants to the concrete ticket ids `assign-batch` (#275) needs — the console drafts by
   * plant (unchanged from #273), but the write is ticket-shaped, so the review screen calls this once,
   * right before showing the diff, to turn each lane's plant ids into the ticket ids it will commit.
   * Same predicate as {@link listForScope} and `assignPlants`, so the count the pool showed and the
   * ids this resolves can never disagree about which tickets are "assignable".
   */
  async ticketIdsForPlants(
    scope: ZmScope,
    plantIds: bigint[],
    now: Date = new Date(),
  ): Promise<{ plantId: string; ticketIds: string[] }[]> {
    if (plantIds.length === 0) return [];
    const day = istDate(now);
    const plantClamp = this.zoneClamp(scope);
    const rows = await this.prisma.ticket.findMany({
      where: {
        plantId: { in: plantIds },
        ...assignableTickets(day),
        ...(plantClamp ? { plant: plantClamp } : {}),
      },
      select: { ticketId: true, plantId: true },
      orderBy: { createdAt: 'asc' },
    });
    const byPlant = new Map<string, string[]>();
    for (const id of plantIds) byPlant.set(String(id), []);
    for (const r of rows) byPlant.get(String(r.plantId))?.push(r.ticketId);
    return [...byPlant].map(([plantId, ticketIds]) => ({ plantId, ticketIds }));
  }

  /**
   * A ZONAL_MANAGER sees their own zone; CSM / Operations Head see every zone — the same clamp every
   * other manager read on this controller applies, hung off the **plant's** zone because that is the
   * ZM's row-scoping key (`plants.zone_id`, the operational zone, not AutoPlant's per-company one).
   */
  private zoneClamp(scope: ZmScope): { zoneId: bigint } | null {
    return scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? { zoneId: BigInt(scope.zoneId) } : null;
  }
}
