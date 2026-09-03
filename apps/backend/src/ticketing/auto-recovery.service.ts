import { Injectable, Logger } from '@nestjs/common';
import { LostRaceError, stampOnceOrLose } from '../common/lost-race';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REMOVAL_REASONS } from '../scheduling/removal-reason';
import { readAssignmentThresholdHours } from '../settings/assignment-threshold';
import {
  meetsRecoveryEvidence,
  summariseRecoveryPings,
  type RecoveryEvidence,
  type RecoveryThresholds,
} from './recovery-criteria';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AutoRecoveryActor {
  userId: string;
  role: string;
  actedAsRole?: string | null;
  /**
   * The zone whose ZM duty this write is being made under, when the caller is acting (#340).
   * Attribution, not scope: it names who was covering, never what the caller may touch.
   */
  actingZone?: number | null;
}

export type ManualCloseResult = 'CLOSED' | 'NOT_FOUND' | 'NOT_OPEN';

export interface AutoRecoveryOptions {
  now?: Date;
  thresholds?: RecoveryThresholds;
  /**
   * Cap on closures **per pass** — the resume point the original all-or-nothing loop never had
   * (#229 D9). Candidates are walked oldest-cycle-first, so a capped pass is a prefix of the same
   * ordering and the next pass continues where it stopped; nothing is skipped or revisited.
   */
  maxClosures?: number;
  /** Restrict to one zone, for a staged first drain (#229 §5.4.3). */
  zoneId?: number | bigint;
  /** Compute the plan and write NOTHING. Backs `npm run autorecovery:dryrun`. */
  dryRun?: boolean;
}

/** One qualifying ticket plus the evidence that qualified it — a count is not evidence (#229 gate 1). */
export interface AutoRecoveryPlanRow extends RecoveryEvidence {
  ticketId: string;
  ticketNo: string;
  deviceId: string;
  cycleId: string;
  cycleOpenedAt: Date;
  plantId: string;
  companyId: string;
  zoneId: string | null;
}

/**
 * Per-pass closure budget (#229 D9). Deliberately **defaulted, not opt-in**: the qualifying backlog
 * is ~11,042 tickets whose ping evidence is already on disk, so an uncapped first pass would close
 * all of them in one transaction storm the moment telemetry is enabled — an operational event
 * arriving as a deploy side-effect. With the cap the first drain is a sequence of bounded, resumable
 * passes the operator watches and can stop by changing one variable.
 *
 * In steady state the cap never binds (a live tick closes single to low-double digits), so this
 * costs nothing once the backlog is gone. `AUTO_RECOVERY_MAX_PER_PASS=unlimited` removes it.
 */
export const DEFAULT_AUTO_RECOVERY_MAX_PER_PASS = 200;

export function readAutoRecoveryMaxPerPass(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.AUTO_RECOVERY_MAX_PER_PASS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_AUTO_RECOVERY_MAX_PER_PASS;
  if (raw.toLowerCase() === 'unlimited') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_AUTO_RECOVERY_MAX_PER_PASS;
}

export interface AutoRecoveryResult {
  /** Tickets closed (or, under `dryRun`, that WOULD have been closed). */
  closed: number;
  /** Candidates the DB scan returned — open TROUBLESHOOT tickets on currently-healthy devices. */
  scanned: number;
  /** Candidates whose pings were actually evaluated. Below `scanned` only when `capped`. */
  examined: number;
  /** True when `maxClosures` stopped the pass with candidates still unexamined. */
  capped: boolean;
  /**
   * #302 — candidates this pass declined to close because the ticket left `OPEN` between the scan and
   * the write (an SE submitted their form, a manager closed it by hand, an overlapping pass got there).
   *
   * Counted rather than logged, for the same reason `VerificationSweepResult.skipped` is: a pass that
   * found five recovered devices and closed three is a different fact from one that found three, and
   * the two must not report the same shape.
   */
  skipped: number;
  /** Present only under `dryRun`. */
  plan?: AutoRecoveryPlanRow[];
}

/**
 * AutoRecoveryService (CONTEXT "Auto-Recovery", Issue 08). A device that resumes pinging **without
 * any SE troubleshooting form** closes its Ticket as `CLOSED_AUTO_RECOVERY` — kept distinct from an
 * SE-repaired `CLOSED` so productivity and component reports are not inflated by self-healing
 * devices. The cycle goes `VERIFIED`, the open-cycle flag clears, and the closure is recorded in
 * `ticket_events` **and** `audit_logs`, all in one transaction.
 *
 * **Trigger (#229).** `runAutoRecovery` is the *auto-recovery pre-check* the architecture specifies
 * between device-state recompute and ticket creation
 * (`fsm-backend-low-level-design.md:615`, `fsm-business-technical-workflow.md:512`). It is called
 * from `IntegrationSyncService` on every telemetry pass — **not** from a `@Cron`. For eleven months
 * it had no production caller at all, which is why 11,042 closable tickets accumulated; the
 * mechanism was built, tested and unreachable.
 *
 * **Why the scan requires a currently-healthy device (#229 D3).** "Auto-recovery" is a claim about
 * *now* — this device is back — not about whether some window in the past contained three pings. A
 * flapping device satisfies the ping evidence and is still down; closing its ticket only to have
 * ticket creation re-open a `REPEAT`-flagged cycle milliseconds later (ADR-0021) manufactures
 * escalations for work nobody did. Filtering on `device_states.is_inactive = false` is meaningful
 * *only* at this position in the pipeline, where recompute has just run — a standalone cron would be
 * reading a figure up to a full cadence stale. Placement and correctness are the same decision here.
 *
 * The two stages are then exact complements: creation takes silence **at or past** the SE-assignment
 * threshold, recovery takes silence **below** it, so no device can be touched by both on one pass.
 *
 * **#238 — why this reads `se_assignment_threshold_hours` and not `is_inactive`.** The complement
 * above is load-bearing, and it is a complement of *whatever predicate ticket creation uses*. Once
 * that became the configurable assignment threshold, `is_inactive = false` stopped being its negation:
 * with the threshold at 12 h, a device silent for 18 h is ticketed by creation and — on the very same
 * pass — is not `is_inactive` (the canonical 24 h has not elapsed), so a stale `is_inactive = false`
 * scan would hand it straight back to auto-recovery. The ticket would be opened and closed on every
 * tick, forever, and the closure would be recorded as a self-healing device. Both stages therefore
 * read the one setting, and `NULL` hours are included here because `gte` excludes them there —
 * complementary down to the null case.
 */
@Injectable()
export class AutoRecoveryService {
  private readonly logger = new Logger(AutoRecoveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async runAutoRecovery(options: AutoRecoveryOptions = {}): Promise<AutoRecoveryResult> {
    const { now = new Date(), thresholds = {}, maxClosures, zoneId, dryRun = false } = options;
    const assignmentThresholdHours = await readAssignmentThresholdHours(this.prisma);

    const candidates = await this.prisma.ticket.findMany({
      where: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        // The device must be healthy at the recompute that just ran — see the class docstring. "Healthy"
        // is the exact complement of ticket creation's gate (#238), null hours included.
        device: {
          state: {
            OR: [{ inactivityHours: { lt: assignmentThresholdHours } }, { inactivityHours: null }],
          },
        },
        ...(zoneId !== undefined ? { plant: { zoneId: BigInt(zoneId) } } : {}),
      },
      include: { failureCycle: true, plant: { select: { zoneId: true } } },
      // Oldest failure first: the longest-stale tickets are the least ambiguous, and it makes a
      // capped pass a deterministic prefix rather than an arbitrary sample.
      orderBy: { failureCycle: { openedAt: 'asc' } },
    });

    let closed = 0;
    let examined = 0;
    let skipped = 0;
    let capped = false;
    const plan: AutoRecoveryPlanRow[] = [];

    for (const ticket of candidates) {
      if (maxClosures !== undefined && closed >= maxClosures) {
        capped = true;
        break;
      }
      const cycle = ticket.failureCycle;
      if (!cycle) continue;
      examined++;

      // No SE troubleshooting form may have been submitted (CONTEXT §Auto-Recovery). Issue 16 moves a
      // ticket to VERIFICATION_PENDING on submit, so the `status: 'OPEN'` scan above already excludes
      // any ticket that has a submission — auto-recovery can only fire on a never-worked ticket.
      const pings = await this.prisma.rawDeviceSnapshot.findMany({
        where: { deviceId: ticket.deviceId, gpsDatetime: { gt: cycle.openedAt } },
        select: { gpsDatetime: true },
      });
      const evidence = summariseRecoveryPings(pings.map((p) => p.gpsDatetime));
      if (!meetsRecoveryEvidence(evidence, thresholds)) continue;

      if (dryRun) {
        plan.push({
          ...evidence,
          ticketId: ticket.ticketId,
          ticketNo: ticket.ticketNo.toString(),
          deviceId: ticket.deviceId,
          cycleId: cycle.cycleId,
          cycleOpenedAt: cycle.openedAt,
          plantId: ticket.plantId.toString(),
          companyId: ticket.companyId.toString(),
          zoneId: ticket.plant?.zoneId?.toString() ?? null,
        });
      } else {
        try {
          await this.closeAsAutoRecovery({
            ticketId: ticket.ticketId,
            fromStatus: ticket.status,
            cycleId: cycle.cycleId,
            deviceId: ticket.deviceId,
            now,
            evidence,
          });
        } catch (e) {
          // #302 — the ticket left OPEN under us. Not an error and not a retry: whoever moved it did so
          // with better information than a scan taken minutes ago, and the recovery evidence will still
          // be there next pass if the ticket really is still open. The cap is not consumed either — a
          // skip did no work.
          if (!(e instanceof LostRaceError)) throw e;
          this.logger.warn(`${e.message} — ticket left OPEN mid-pass, close skipped`);
          skipped++;
          continue;
        }
      }
      closed++;
    }

    return { closed, scanned: candidates.length, examined, skipped, capped, ...(dryRun ? { plan } : {}) };
  }

  /**
   * A ZM (or CSM/OpsHead) manually marks an open Troubleshoot Ticket CLOSED_AUTO_RECOVERY (AC#3).
   * Zone-scoped: a ZONAL_MANAGER may only close own-zone tickets (else NOT_FOUND). Already-closed
   * tickets are NOT_OPEN (→ 409).
   */
  async manualClose(
    ticketId: string,
    scope: { role: string; zoneId: number | null },
    actor: AutoRecoveryActor,
    now: Date = new Date(),
  ): Promise<ManualCloseResult> {
    if (!UUID_RE.test(ticketId)) return 'NOT_FOUND';
    const zoneWhere =
      scope.role === 'ZONAL_MANAGER' && scope.zoneId !== null
        ? { plant: { zoneId: BigInt(scope.zoneId) } }
        : {};
    const ticket = await this.prisma.ticket.findFirst({
      where: { ticketId, ...zoneWhere },
      include: { failureCycle: true },
    });
    if (!ticket) return 'NOT_FOUND';
    if (ticket.status !== 'OPEN' || ticket.workType !== 'TROUBLESHOOT' || !ticket.failureCycle)
      return 'NOT_OPEN';

    try {
      await this.closeAsAutoRecovery({
        ticketId: ticket.ticketId,
        fromStatus: ticket.status,
        cycleId: ticket.failureCycle.cycleId,
        deviceId: ticket.deviceId,
        now,
        actor,
      });
    } catch (e) {
      // #302 — the ticket stopped being OPEN between this method's own check and its write. That is
      // precisely what NOT_OPEN already means to this door, so the caller gets the same honest 409 it
      // would have got a moment earlier, instead of a silent second close on top of somebody else's.
      if (e instanceof LostRaceError) return 'NOT_OPEN';
      throw e;
    }
    return 'CLOSED';
  }

  /**
   * Close a single Ticket as auto-recovered. `actor` null = system (the pre-check); set = ZM manual
   * close. Seven writes, one transaction.
   *
   * **#229 §5.2 — four of these were missing and each produced a wrong screen or a wrong number:**
   *
   * - `closed_at` + `closure_type`. `fleet-uptime-aggregation.service.ts:86-91` counts closures by
   *   `closed_at`, so without it `autoRecoveryClosures` stayed 0 no matter how many tickets closed —
   *   the exact metric PRD story 25 exists to produce, reading zero on the day it fired.
   * - The `audit_logs` row every sibling system-closure writer emits (device-departure,
   *   plant-deactivation, verification). `ticket_events` is the narrower lifecycle ledger, not an
   *   audit trail.
   * - Soft-state resolution. CONTEXT §Soft States names auto-recovery as an explicit resolution
   *   event for `ON_SITE` / `TROUBLESHOOT_STARTED`; they were left dangling.
   * - Batch detachment. `MeTicketsQueryService` builds the SE day plan from `batch_assignment_tickets`
   *   with no status filter, so a closed ticket rendered as work-to-do on the SE's app indefinitely.
   *   Detaching here is truer to the data model than filtering at read time, because #175's
   *   work-history read derives from the same rows.
   */
  async closeAsAutoRecovery(input: {
    ticketId: string;
    fromStatus: string;
    cycleId: string;
    deviceId: string;
    now: Date;
    actor?: AutoRecoveryActor | null;
    evidence?: RecoveryEvidence | null;
  }): Promise<void> {
    const { ticketId, fromStatus, cycleId, deviceId, now, actor = null, evidence = null } = input;
    // `removed_by` / audit actor are UUID-shaped columns; the system pass has no user to name.
    const actorUuid = actor && UUID_RE.test(actor.userId) ? actor.userId : null;

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // #302 — `status: 'OPEN'` belongs in the WHERE, not only in the caller's scan.
      //
      // The scan that selected this ticket ran minutes ago (per-ticket ping queries, up to 200 closures
      // a pass), and `manualClose`'s check ran before its own await. The sweep's comment claims the OPEN
      // scan enforces CONTEXT's "no SE troubleshooting form may have been submitted" — a scan cannot
      // enforce anything about the moment of the write, and a submission moving the ticket to
      // VERIFICATION_PENDING is exactly the event most likely to land in that window. Losing throws, so
      // all seven writes below roll back together: a skipped close leaves no event, no audit row, no
      // closed cycle and no detached day-plan row for somebody to explain later.
      await stampOnceOrLose(
        tx.ticket,
        { ticketId, status: 'OPEN' },
        {
          status: 'CLOSED_AUTO_RECOVERY',
          closureType: 'AUTO_RECOVERY_CLOSE',
          closureReason: actor
            ? 'MANUAL_AUTO_RECOVERY: closed by manager'
            : 'AUTO_RECOVERY: device resumed pinging before any SE submission',
          closedAt: now,
          lastStateChangedAt: now,
        },
        `auto-recovery close for ticket ${ticketId}`,
      );
      await tx.failureCycle.update({
        where: { cycleId },
        data: { state: 'VERIFIED', closedAt: now },
      });
      await tx.ticketEvent.create({
        data: {
          ticketId,
          fromState: fromStatus,
          toState: 'CLOSED_AUTO_RECOVERY',
          at: now,
          actorId: actor?.userId ?? null,
          actorRole: (actor?.role as never) ?? null,
          actedAsRole: (actor?.actedAsRole as never) ?? null,
          reasonCode: actor ? 'MANUAL_AUTO_RECOVERY' : 'AUTO_RECOVERY',
        },
      });
      await tx.deviceState.updateMany({
        where: { deviceId },
        data: { hasOpenFailureCycle: false },
      });
      // CONTEXT §Soft States — "Ticket closes through valid system rules (… auto-recovery …)" is a
      // resolution event. Every SE's active soft state on this ticket resolves, not just one.
      await tx.softState.updateMany({
        where: { ticketId, resolvedAt: null },
        data: { resolvedAt: now, resolvedBy: 'SYSTEM', resolutionReason: 'AUTO_RECOVERY' },
      });
      // Take it off every SE day plan that still holds it. `removedBy` stays NULL for the unattended
      // sweep, which is exactly why #241 exists: that NULL was the *only* signal this path left, so
      // nothing could tell an auto-recovery removal from any other system removal. The reason column
      // now carries it explicitly, and no reader should infer "system" from a NULL actor any more.
      await tx.batchAssignmentTicket.updateMany({
        where: { ticketId, removedAt: null },
        data: { removedAt: now, removedBy: actorUuid, removalReason: REMOVAL_REASONS.AUTO_RECOVERY },
      });
      await tx.auditLog.create({
        data: {
          actorId: actorUuid ?? 'SYSTEM',
          actorRole: actor?.role ?? 'SYSTEM',
          actedAsRole: actor?.actedAsRole ?? null,
          actingZone: actor?.actingZone != null ? BigInt(actor.actingZone) : null,
          action: 'AUTO_RECOVERY_CLOSED',
          entityType: 'TICKET',
          entityId: ticketId,
          metadata: {
            deviceId,
            cycleId,
            manual: actor !== null,
            pingCount: evidence?.pingCount ?? null,
            firstPing: evidence?.firstPing?.toISOString() ?? null,
            lastPing: evidence?.lastPing?.toISOString() ?? null,
            spanMinutes: evidence?.spanMinutes ?? null,
          },
        },
      });
    });
  }
}
