import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { resolveActiveOverrides, tierOverrideKey } from '../org/effective-tier';
import { PrismaService } from '../prisma/prisma.service';
import { readAssignmentThresholdHours } from '../settings/assignment-threshold';

/** Postgres unique-violation → Prisma P2002. Here it means invariant I1 already holds (an active
 *  Failure Cycle exists for the device), so this device is silently skipped. */
const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** Repeat window (ADR-0021): a re-failure within 24h of a prior VERIFIED closure is a REPEAT. */
const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * TicketCreationService — the raw-telemetry-to-open-Ticket step (LLD TicketCreation, schema D6).
 *
 * Scans `device_states` for devices that have been **silent past the SE-assignment threshold**, are
 * **eligible**, and have **no open episode**, and for each opens one `failure_cycle` (OPEN) plus its
 * one parented `ticket` (work_type=TROUBLESHOOT, status=OPEN, `company_tier` denormalised from
 * `company_master`), then flips `has_open_failure_cycle`. All three writes commit in one transaction
 * so a device never ends up with a cycle but no ticket. The active-cycle partial-unique (invariant
 * I1) backstops the `has_open_failure_cycle` filter against races/staleness — a duplicate just skips
 * that device.
 *
 * **#238 — the gate is `inactivity_hours >= se_assignment_threshold_hours`, not `is_inactive`.**
 * The two were the same predicate until the assignment threshold became configurable, and the
 * substitution is the whole point: `is_inactive` is a *measurement* (it defines the Fleet-Uptime
 * denominator and the Soft Inactive Count zones are graded on) while this is a *policy decision*
 * about when silence becomes fieldwork. Reading the hours directly lets an operator open work earlier
 * than the KPI calls a device Inactive, or hold off past it, without either choice restating a single
 * historical number. At the shipped default (both 24) the predicate is exactly what it always was.
 *
 * The complement matters as much as the gate: {@link AutoRecoveryService} closes on
 * `inactivity_hours < threshold` reading the **same** setting, so creation and recovery remain exact
 * complements and no device can be touched by both on one pass. Changing the threshold here without
 * changing it there would let a device be ticketed and auto-closed on the same tick, forever.
 */
@Injectable()
export class TicketCreationService {
  constructor(private readonly prisma: PrismaService) {}

  async createForInactiveEligible(now: Date = new Date()): Promise<{ created: number }> {
    const thresholdHours = await readAssignmentThresholdHours(this.prisma);
    // Deactivated plants (Issue 119) are excluded here so no new Troubleshoot Ticket is opened for a
    // shut plant; on reactivation the exclusion lifts and the next run re-creates for still-inactive devices.
    const deactivatedPlantIds = (
      await this.prisma.plantDeactivation.findMany({ where: { reactivatedAt: null }, select: { plantId: true } })
    ).map((r) => r.plantId);
    const candidates = await this.prisma.deviceState.findMany({
      where: {
        // #238 — the configurable SE-assignment threshold (see the class docstring). NULL hours are
        // excluded by `gte`, which is the pre-existing behaviour: a device with neither a ping nor an
        // install date has no measurable silence and was never ticketed (#223/#227).
        inactivityHours: { gte: thresholdHours },
        eligibleForUptime: true,
        hasOpenFailureCycle: false,
        // Departed devices (Issue 128) are never ticketed — a device sitting in a warehouse is not a
        // field failure. #130 L2: re-reads the `device_departures` ledger directly — the IDENTICAL
        // shape the recommender already uses (`recommender.service.ts:113`) — instead of trusting the
        // derived `is_departed` flag. The 2026-07-19 run-65 incident is exactly why: a stale-code
        // recompute cleared `is_departed` fleet-wide while the ledger still held the active departure,
        // and the flag-only gate opened for every departed device. The derived flag stays a useful fast
        // filter elsewhere (dashboards, cheap predicates) — this write path is safety-critical, so it
        // re-reads the source of truth instead.
        device: { departures: { none: { restoredAt: null } } },
        // A Troubleshoot Ticket needs a plant + company; a device with no current fitment can't be ticketed.
        plantId: deactivatedPlantIds.length > 0 ? { not: null, notIn: deactivatedPlantIds } : { not: null },
        companyId: { not: null },
      },
    });
    if (candidates.length === 0) return { created: 0 };

    const companyIds = [...new Set(candidates.map((c) => c.companyId!))];
    const companies = await this.prisma.company.findMany({
      where: { companyId: { in: companyIds } },
      select: { companyId: true, companyTier: true },
    });
    const tierByCompany = new Map(companies.map((c) => [c.companyId, c.companyTier]));

    // Issue 157 — a new Troubleshoot Ticket is stamped with the EFFECTIVE tier (global, unless a
    // CSM/ZM override is ACTIVE for this company in the plant's zone), so the tickets.company_tier
    // snapshot a candidate's Platinum cross-zone auto-escalation eligibility reads is never stale
    // from the moment of creation. Batched: one plant lookup + one override lookup for the whole sweep.
    const plantIds = [...new Set(candidates.map((c) => c.plantId!))];
    const plants = await this.prisma.plant.findMany({
      where: { plantId: { in: plantIds } },
      select: { plantId: true, zoneId: true },
    });
    const zoneByPlant = new Map(plants.map((p) => [p.plantId, p.zoneId]));
    const zoneIds = [...new Set([...zoneByPlant.values()])];
    const overrides = await resolveActiveOverrides(this.prisma, zoneIds, now);

    let created = 0;
    for (const ds of candidates) {
      const globalTier = tierByCompany.get(ds.companyId!);
      if (!globalTier) continue; // company row missing — skip defensively rather than violate the FK
      const zoneId = zoneByPlant.get(ds.plantId!);
      const companyTier =
        zoneId !== undefined ? (overrides.get(tierOverrideKey(ds.companyId!, zoneId))?.tier ?? globalTier) : globalTier;

      // Repeat detection (ADR-0021, event-driven): a prior VERIFIED cycle closed within the last 24h
      // makes this a REPEAT. "Repair completion" is GPS-verified closure, not form submission.
      const priorVerified = await this.prisma.failureCycle.findFirst({
        where: {
          deviceId: ds.deviceId,
          state: 'VERIFIED',
          closedAt: { gte: new Date(now.getTime() - REPEAT_WINDOW_MS) },
        },
        orderBy: { closedAt: 'desc' },
        select: { cycleId: true },
      });
      const isRepeat = priorVerified !== null;

      try {
        await this.prisma.$transaction(async (tx) => {
          const cycle = await tx.failureCycle.create({
            data: {
              deviceId: ds.deviceId,
              state: isRepeat ? 'REPEAT' : 'OPEN',
              openedAt: now,
              repeatFailure: isRepeat,
              previousFailureCycleId: priorVerified?.cycleId ?? null,
            },
          });
          const ticket = await tx.ticket.create({
            data: {
              workType: 'TROUBLESHOOT',
              status: 'OPEN',
              failureCycleId: cycle.cycleId,
              deviceId: ds.deviceId,
              vehicleId: ds.vehicleId,
              plantId: ds.plantId!,
              companyId: ds.companyId!,
              companyTier,
              repeatFailure: isRepeat,
              lastStateChangedAt: now,
            },
          });
          // Opening transition on the lifecycle timeline (schema D6). System-generated creation, so
          // there is no human actor; later issues append their transitions with actor/role.
          await tx.ticketEvent.create({
            data: { ticketId: ticket.ticketId, fromState: null, toState: 'OPEN', at: now },
          });
          await tx.deviceState.update({
            where: { deviceId: ds.deviceId },
            data: { hasOpenFailureCycle: true },
          });
        });
        created++;
      } catch (e) {
        if (isUniqueViolation(e)) continue; // invariant I1: an active cycle already exists — skip.
        throw e;
      }
    }

    return { created };
  }
}
