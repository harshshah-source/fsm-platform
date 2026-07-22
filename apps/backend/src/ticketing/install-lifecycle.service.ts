import { Inject, Injectable, Optional } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { $Enums } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { INSTALL_NOTIFIER, type InstallNotifier, LoggingInstallNotifier } from './install-notifier';

type TicketStatus = $Enums.TicketStatus;

/** Roles that schedule (dispatch/assign) an Install Ticket to an SE. */
const MANAGER_ROLES = new Set(['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']);

/**
 * The caller's real zone authority for install scoping (Issue 102 / audit HIGH #9) — REAL role + home
 * zone + id, exactly the `{ role: user.role, zoneId: user.zone_id }` the create/CSV path already scopes
 * with. A ZONAL_MANAGER is clamped to their home zone; CENTRAL_SERVICE_MANAGER / OPERATIONS_HEAD (and the
 * WAREHOUSE_MANAGER reader) keep cross-zone reach; an SE reads only its own assigned ticket.
 */
export interface InstallScope {
  role: string;
  zoneId: number | null;
  userId: string;
}

/**
 * How long after ACTIVATED the install auto-verification waits for the first valid ping before
 * declaring FAILED_ACTIVATION. 24 h mirrors the troubleshoot verification window (Issue 18); a late
 * ping still verifies (a real device that came up late is a successful install).
 */
export const INSTALL_ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface InstallVerificationSweepResult {
  verified: number;
  failed: number;
  pending: number;
}

export interface InstallView {
  ticketId: string;
  status: TicketStatus;
  deviceId: string;
  assignedSeId: string | null;
  fittedGpsSerial: string | null;
  fittedSimSerial: string | null;
  fittedPhotoRef: string | null;
  fittedAt: Date | null;
  activatedAt: Date | null;
  closedAt: Date | null;
}

export type InstallOutcome =
  | { result: 'OK'; ticket: InstallView }
  | { result: 'NOT_FOUND' }
  | { result: 'WRONG_STATE' }
  | { result: 'FORBIDDEN' }
  | { result: 'INVALID_SERIAL' }
  | { result: 'SERIAL_REQUIRED' };

/** The mandatory GPS device serial + SIM serial (optional photo) captured at the FITTED stage. */
export interface FitmentInput {
  gpsDeviceSerial: string;
  simSerial: string;
  photoRef?: string | null;
}

/** The minimal ticket shape the service reads for a lifecycle transition. */
interface TicketRow {
  ticketId: string;
  workType: $Enums.WorkType;
  status: TicketStatus;
  deviceId: string;
  assignedSeId: string | null;
}

/**
 * Install Ticket field workflow (Issue 34, CONTEXT.md §4). Lifecycle
 * REQUESTED → SCHEDULED → ON_SITE → FITTED → ACTIVATED → CLOSED (or FAILED_ACTIVATION). This service
 * owns the manager dispatch + the SE field legs (on-site, the Install Form) and the install
 * auto-verification sweep. Every transition is state-guarded, audited, and appends a `ticket_events`
 * row. Mirrors `RecoveryService`. Verification follows the new `device_id`'s first valid post-fitment
 * ping with **no geofence** (no prior location is known — LLD open item #5).
 */
@Injectable()
export class InstallLifecycleService {
  private readonly notifier: InstallNotifier;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() @Inject(INSTALL_NOTIFIER) notifier?: InstallNotifier,
  ) {
    this.notifier = notifier ?? new LoggingInstallNotifier();
  }

  /** Manager dispatch: REQUESTED → SCHEDULED, assigning the SE (manager roles, own-zone for a ZM). */
  async scheduleInstall(ticketId: string, seId: string, actor: RequestActor, scope: InstallScope): Promise<InstallOutcome> {
    if (!MANAGER_ROLES.has(actor.role)) return { result: 'FORBIDDEN' };
    const ticket = await this.load(ticketId);
    if (!ticket) return { result: 'NOT_FOUND' };
    // Zone clamp (Issue 102): a ZM cannot dispatch SEs onto an install ticket in another zone. Checked
    // before the state read so an out-of-zone ZM can't probe a ticket's status via WRONG_STATE.
    if (!this.zoneAllows(scope, await this.ticketZoneId(ticketId))) return { result: 'FORBIDDEN' };
    if (ticket.status !== 'REQUESTED') return { result: 'WRONG_STATE' };
    return this.transition(ticket, 'SCHEDULED', actor, 'INSTALL_SCHEDULED', { assignedSeId: seId });
  }

  /** SE arrives at the fitment site: SCHEDULED → ON_SITE (assigned SE only). */
  async markOnSite(ticketId: string, actor: RequestActor): Promise<InstallOutcome> {
    const ticket = await this.load(ticketId);
    if (!ticket) return { result: 'NOT_FOUND' };
    if (ticket.status !== 'SCHEDULED') return { result: 'WRONG_STATE' };
    if (!this.isAssignedSe(ticket, actor)) return { result: 'FORBIDDEN' };
    return this.transition(ticket, 'ON_SITE', actor, 'INSTALL_ON_SITE', {});
  }

  /**
   * Install Form: ON_SITE → FITTED → ACTIVATED (assigned SE). The GPS device serial is mandatory and
   * validated against the ticket's device (it IS the new `device_id` auto-verification tracks); the SIM
   * serial is mandatory; the photo is optional. `fitted_at`/`activated_at` are stamped and the ticket
   * enters ACTIVATED so the verification sweep watches for its first valid ping.
   */
  async markFitted(ticketId: string, input: FitmentInput, actor: RequestActor, now: Date = new Date()): Promise<InstallOutcome> {
    const ticket = await this.load(ticketId);
    if (!ticket) return { result: 'NOT_FOUND' };
    if (ticket.status !== 'ON_SITE') return { result: 'WRONG_STATE' };
    if (!this.isAssignedSe(ticket, actor)) return { result: 'FORBIDDEN' };
    if (!input.simSerial?.trim()) return { result: 'SERIAL_REQUIRED' };
    if (input.gpsDeviceSerial?.trim() !== String(ticket.deviceId)) return { result: 'INVALID_SERIAL' };

    const updated = await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'INSTALL_FITTED_ACTIVATED',
        entityType: 'tickets',
        entityId: ticketId,
        metadata: { gpsDeviceSerial: input.gpsDeviceSerial.trim(), simSerial: input.simSerial.trim() },
      },
      async (tx) => {
        // FITTED then the auto-ACTIVATED on form submission — both legs recorded in one tx.
        await tx.ticketEvent.create({ data: { ticketId, fromState: ticket.status, toState: 'FITTED', ...eventActor(actor), at: now } });
        const row = await tx.ticket.update({
          where: { ticketId },
          data: {
            status: 'ACTIVATED',
            fittedGpsSerial: input.gpsDeviceSerial.trim(),
            fittedSimSerial: input.simSerial.trim(),
            fittedPhotoRef: input.photoRef?.trim() || null,
            fittedAt: now,
            activatedAt: now,
            lastStateChangedAt: now,
          },
        });
        await tx.ticketEvent.create({ data: { ticketId, fromState: 'FITTED', toState: 'ACTIVATED', ...eventActor(actor), at: now } });
        return row;
      },
    );
    return { result: 'OK', ticket: toView(updated) };
  }

  /**
   * Install auto-verification sweep (AC#3/#4/#6). Re-entrant scan of ACTIVATED install tickets: the
   * first valid ping for the new `device_id` after `activated_at` closes the Ticket (CLOSED) and fires
   * the verified push — NO geofence (no prior location). If no ping has arrived and the activation
   * window has elapsed, the Ticket goes FAILED_ACTIVATION with a push. Idempotent — safe to run every
   * few minutes; a BullMQ cron wires to it when scheduling lands (same posture as `VerificationService`).
   */
  async runInstallVerification(
    now: Date = new Date(),
    opts: { ticketIds?: string[] } = {},
  ): Promise<InstallVerificationSweepResult> {
    const tickets = await this.prisma.ticket.findMany({
      where: { workType: 'INSTALL', status: 'ACTIVATED', ...(opts.ticketIds ? { ticketId: { in: opts.ticketIds } } : {}) },
      select: { ticketId: true, deviceId: true, assignedSeId: true, activatedAt: true },
    });

    // #148: read the telemetry watermark ONCE per sweep — a single global value, and this sweep runs
    // every few minutes over every ACTIVATED install ticket.
    const telemetryAsOf = await this.telemetryWatermark();

    const result: InstallVerificationSweepResult = { verified: 0, failed: 0, pending: 0 };
    for (const t of tickets) {
      const anchor = t.activatedAt ?? now;
      // First valid post-fitment ping for this device. A ping at all means the fitted device is alive —
      // no distance check (LLD open item #5: no prior location to geofence against).
      const firstPing = await this.prisma.rawDeviceSnapshot.findFirst({
        where: { deviceId: t.deviceId, gpsDatetime: { gt: anchor } },
        orderBy: { gpsDatetime: 'asc' },
        select: { gpsDatetime: true },
      });

      if (firstPing) {
        await this.closeVerified(t, now);
        await this.notifier.installVerified({ ticketId: t.ticketId, deviceId: t.deviceId, seId: t.assignedSeId });
        result.verified++;
      } else if (this.activationWindowExpired(anchor, now, telemetryAsOf)) {
        await this.failActivation(t, now);
        await this.notifier.failedActivation({ ticketId: t.ticketId, deviceId: t.deviceId, seId: t.assignedSeId });
        result.failed++;
      } else {
        result.pending++;
      }
    }
    return result;
  }

  /**
   * Newest telemetry watermark — the `data_as_of` of the most recent snapshot run that recorded one.
   * Same read as `VerificationService.telemetryWatermark` and `AutoPlantHealthService.snapshotHealth`,
   * deliberately: "how fresh is telemetry" has one definition on this platform. `null` = never recorded.
   */
  private async telemetryWatermark(): Promise<Date | null> {
    const lastGood = await this.prisma.snapshotRun.findFirst({
      where: { dataAsOf: { not: null } },
      orderBy: { runId: 'desc' },
      select: { dataAsOf: true },
    });
    return lastGood?.dataAsOf ?? null;
  }

  /**
   * #148 — the install half of the staleness precondition (see `VerificationService.windowExpired`
   * for the full rationale; this sweep resolves the same 24 h window against the same
   * `raw_device_snapshots` and carried the identical defect).
   *
   * Activation may fail only once BOTH hold: the window has elapsed AND telemetry has advanced past
   * activation. With ingestion paused, a device fitted and activated perfectly would otherwise age
   * into FAILED_ACTIVATION — and fire a "failed activation" push at the SE — because no ping *could*
   * be written. A null watermark counts as "not advanced": conservative by construction.
   */
  private activationWindowExpired(anchor: Date, now: Date, telemetryAsOf: Date | null): boolean {
    if (now.getTime() - anchor.getTime() < INSTALL_ACTIVATION_WINDOW_MS) return false;
    return telemetryAsOf != null && telemetryAsOf.getTime() > anchor.getTime();
  }

  /** ACTIVATED → CLOSED on a verified first ping (SYSTEM-driven, audited, one tx). */
  private async closeVerified(t: { ticketId: string; deviceId: string }, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({ where: { ticketId: t.ticketId }, data: { status: 'CLOSED', closedAt: now, lastStateChangedAt: now } });
      await tx.ticketEvent.create({ data: { ticketId: t.ticketId, fromState: 'ACTIVATED', toState: 'CLOSED', reasonCode: 'INSTALL_VERIFIED', at: now } });
      await tx.auditLog.create({ data: { actorId: 'SYSTEM', actorRole: 'SYSTEM', action: 'INSTALL_VERIFIED', entityType: 'tickets', entityId: t.ticketId, metadata: { deviceId: String(t.deviceId) } } });
    });
  }

  /** ACTIVATED → FAILED_ACTIVATION when the activation window elapses with no valid ping (SYSTEM, audited). */
  private async failActivation(t: { ticketId: string; deviceId: string }, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({ where: { ticketId: t.ticketId }, data: { status: 'FAILED_ACTIVATION', lastStateChangedAt: now } });
      await tx.ticketEvent.create({ data: { ticketId: t.ticketId, fromState: 'ACTIVATED', toState: 'FAILED_ACTIVATION', reasonCode: 'INSTALL_FAILED_ACTIVATION', at: now } });
      await tx.auditLog.create({ data: { actorId: 'SYSTEM', actorRole: 'SYSTEM', action: 'INSTALL_FAILED_ACTIVATION', entityType: 'tickets', entityId: t.ticketId, metadata: { deviceId: String(t.deviceId) } } });
    });
  }

  /**
   * Read an Install Ticket's lifecycle + fitment serials (AC#5 WM visibility), zone/own-ticket scoped
   * (Issue 102 AC#2). A ZM sees only its zone; an SE only its own assigned ticket; WM / CSM / OH keep the
   * cross-zone read. Out of scope → null (the controller 404s) so serials — and a ticket's very existence
   * — never leak across a zone boundary. Null too if the ticket is not an install.
   */
  async getInstallView(ticketId: string, scope: InstallScope): Promise<InstallView | null> {
    const t = await this.prisma.ticket.findUnique({
      where: { ticketId },
      include: { plant: { select: { zoneId: true } } },
    });
    if (!t || t.workType !== 'INSTALL') return null;
    if (!this.zoneAllows(scope, t.plant?.zoneId ?? null)) return null;
    if (scope.role === 'SERVICE_ENGINEER' && t.assignedSeId !== scope.userId) return null;
    return toView(t);
  }

  /** The install ticket's operational zone (via plant → zone), or null if unresolved / not found. */
  private async ticketZoneId(ticketId: string): Promise<bigint | null> {
    const t = await this.prisma.ticket.findUnique({
      where: { ticketId },
      select: { plant: { select: { zoneId: true } } },
    });
    return t?.plant?.zoneId ?? null;
  }

  /**
   * Whether `scope` may act on / read an install ticket in `ticketZoneId`. A ZONAL_MANAGER is clamped to
   * their home zone; every other role (CSM/OH cross-zone authority, WM reader) passes — the SE own-ticket
   * rule is applied separately by the read path.
   */
  private zoneAllows(scope: InstallScope, ticketZoneId: bigint | null): boolean {
    if (scope.role !== 'ZONAL_MANAGER') return true;
    return scope.zoneId != null && ticketZoneId != null && BigInt(scope.zoneId) === ticketZoneId;
  }

  private async load(ticketId: string): Promise<TicketRow | null> {
    const t = await this.prisma.ticket.findUnique({ where: { ticketId } });
    if (!t || t.workType !== 'INSTALL') return null;
    return { ticketId: t.ticketId, workType: t.workType, status: t.status, deviceId: t.deviceId, assignedSeId: t.assignedSeId };
  }

  private isAssignedSe(ticket: TicketRow, actor: RequestActor): boolean {
    return actor.role === 'SERVICE_ENGINEER' && ticket.assignedSeId === actor.userId;
  }

  /** Applies one status transition inside an audited transaction + appends a ticket_events row. */
  private async transition(
    ticket: TicketRow,
    toState: TicketStatus,
    actor: RequestActor,
    action: string,
    extra: Record<string, unknown>,
    now: Date = new Date(),
  ): Promise<InstallOutcome> {
    const updated = await this.audit.withAudit(
      { ...auditActor(actor), action, entityType: 'tickets', entityId: ticket.ticketId },
      async (tx) => {
        const row = await tx.ticket.update({ where: { ticketId: ticket.ticketId }, data: { status: toState, lastStateChangedAt: now, ...extra } });
        await tx.ticketEvent.create({ data: { ticketId: ticket.ticketId, fromState: ticket.status, toState, ...eventActor(actor), at: now } });
        return row;
      },
    );
    return { result: 'OK', ticket: toView(updated) };
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** The actor columns for a `ticket_events` row (bare-uuid actor, role + acted-as proxy). */
function eventActor(actor: RequestActor): { actorId: string | null; actorRole: $Enums.Role; actedAsRole: $Enums.Role | null } {
  return {
    actorId: isUuid(actor.userId) ? actor.userId : null,
    actorRole: actor.role as $Enums.Role,
    actedAsRole: (actor.actedAsRole as $Enums.Role | null) ?? null,
  };
}

function toView(row: {
  ticketId: string;
  status: TicketStatus;
  deviceId: string;
  assignedSeId: string | null;
  fittedGpsSerial: string | null;
  fittedSimSerial: string | null;
  fittedPhotoRef: string | null;
  fittedAt: Date | null;
  activatedAt: Date | null;
  closedAt: Date | null;
}): InstallView {
  return {
    ticketId: row.ticketId,
    status: row.status,
    deviceId: row.deviceId,
    assignedSeId: row.assignedSeId,
    fittedGpsSerial: row.fittedGpsSerial,
    fittedSimSerial: row.fittedSimSerial,
    fittedPhotoRef: row.fittedPhotoRef,
    fittedAt: row.fittedAt,
    activatedAt: row.activatedAt,
    closedAt: row.closedAt,
  };
}
