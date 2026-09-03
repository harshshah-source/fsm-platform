import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ComponentRequestService } from '../component-request/component-request.service';
import {
  dueIngestionNotices,
  ingestionNoticeBody,
  readIngestionAlert,
  readIngestionStreakThreshold,
  type IngestionNoticeKind,
} from '../ingestion/ingestion-alert';
import { prismaIngestionAlertSource, readIngestionCadence } from '../ingestion/snapshot-query.service';
import { PrismaService } from '../prisma/prisma.service';
import { drainProducerRows } from '../scheduling/day-plan-notification-outbox';
import type { TickClaimant } from '../scheduling/cron-tick-claim';
import { NotificationService } from './notification.service';
import { PRD_NOTICE_TYPES, queueNoticeOnce } from './prd-event-notice';

/**
 * #361 — the tick that carries this slice's two **condition-driven** notices.
 *
 * Six of the eight producers this slice adds hang off something a person did: a WM approves, an SE
 * raises, a ZM decides, a reconcile closes a ticket. Those enqueue at the mutation and need no
 * scheduler. Two do not have a mutation to hang off, and that is precisely why they were the two
 * nobody had built:
 *
 *  - **The 7-day waiting-component escalation.** Nothing happens on day seven. The event is the
 *    *absence* of an event — a request nobody has shipped — so only a clock can notice it.
 *  - **Ingestion FAILED / overdue.** #348's whole finding was that a stopped pipeline produces no runs
 *    to hang a hook on: `streak: 0`, `downstreamGated: false`, and every field reporting a healthy
 *    pipeline whose newest data is a day old. A producer wired into the ingestion cron would be the
 *    same mistake one layer down — it would go quiet exactly when the pipeline did.
 *
 * **Why a scheduler of its own rather than a twelfth collaborator on `BusinessSweepSchedulerService`.**
 * Same call `VehicleReturnResumeScheduler` and `ScheduleClosureScheduler` already made, for a stronger
 * reason than tidiness: that class is constructed positionally by a `useFactory` with seventeen
 * arguments, and #338 documented what a thirteenth costs — a factory that stopped one argument short
 * of a deliverer, invisibly, for as long as the happy path kept working. This service reaches nothing
 * that scheduler owns and owes it nothing.
 *
 * The posture is copied verbatim from its neighbours: the `BUSINESS_SWEEPS_ENABLED` master switch is
 * re-checked every tick, an in-flight guard turns an overlapping tick into a logged skip, the tick
 * window is claimed so a second instance is a no-op (#263), and the body NEVER throws out of the cron
 * context.
 */

/**
 * Hourly, on the hour.
 *
 * The upper bound is set by ingestion: a pipeline that stopped at 09:05 should not wait until tomorrow
 * to be reported, and an hour is inside the window where a morning's dispatch can still be rescued.
 * The lower bound is set by nothing — because it does not need to be. Both events dedupe to one notice
 * per entity per IST day, so the cadence controls only how *promptly* the first notice goes out, never
 * how many there are. That is what makes an hourly poll safe here and unsafe without the dedup.
 */
export const DEFAULT_PRD_EVENT_NOTICE_CRON = '0 * * * *';

/** #263 — the registered cron-job name, shared by the decorator and the tick claim. */
export const PRD_EVENT_NOTICE_JOB_NAME = 'business-prd-event-notices';

export interface PrdEventNoticeConfig {
  /** Shares the pipeline master switch — `BUSINESS_SWEEPS_ENABLED === 'true'`. Default OFF. */
  enabled: boolean;
  cron: string;
}

/** Resolve the master switch + cron in one place; anything but the literal 'true' stays OFF. */
export function readPrdEventNoticeConfig(env: NodeJS.ProcessEnv = process.env): PrdEventNoticeConfig {
  return {
    enabled: env.BUSINESS_SWEEPS_ENABLED === 'true',
    cron: env.BUSINESS_SWEEP_PRD_EVENT_NOTICES_CRON?.trim() || DEFAULT_PRD_EVENT_NOTICE_CRON,
  };
}

/** What the tick reports — a cron body NEVER throws out of the cron context. */
export type PrdEventNoticeTickOutcome =
  | { ran: true; waitingComponentZones: number; ingestionNotices: number }
  | { ran: false; reason: 'DISABLED' | 'RUN_IN_PROGRESS' | 'TICK_CLAIMED' | 'ERROR' };

@Injectable()
export class PrdEventNoticeService {
  private readonly logger = new Logger(PrdEventNoticeService.name);
  private readonly config: PrdEventNoticeConfig;
  private inFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly componentRequests: ComponentRequestService,
    private readonly claims: TickClaimant,
    config?: Partial<PrdEventNoticeConfig>,
  ) {
    this.config = { ...readPrdEventNoticeConfig(), ...config };
  }

  @Cron(readPrdEventNoticeConfig().cron, { name: PRD_EVENT_NOTICE_JOB_NAME })
  async noticeTick(now: Date = new Date()): Promise<PrdEventNoticeTickOutcome> {
    if (!this.config.enabled) return { ran: false, reason: 'DISABLED' };
    if (this.inFlight) {
      this.logger.log(`${PRD_EVENT_NOTICE_JOB_NAME} tick skipped — a sweep is already in flight`);
      return { ran: false, reason: 'RUN_IN_PROGRESS' };
    }
    this.inFlight = true;
    try {
      if (!(await this.claims.claimTickOrLog(PRD_EVENT_NOTICE_JOB_NAME, now))) {
        return { ran: false, reason: 'TICK_CLAIMED' };
      }
      // Sequential, and the ingestion arm runs even if the first one throws inside itself — but a
      // throw out of either still leaves through ERROR rather than out of the cron context.
      const { notified } = await this.componentRequests.sweepWaitingComponentEscalations(now);
      const { notified: ingestionNotices } = await this.sweepIngestionAlerts(now);
      return { ran: true, waitingComponentZones: notified, ingestionNotices };
    } catch (e) {
      this.logger.error(
        `${PRD_EVENT_NOTICE_JOB_NAME} tick failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { ran: false, reason: 'ERROR' };
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * #361 — push the Operations Head when ingestion is wedged (FAILED) or silent (overdue).
   *
   * **Read the same derivation the surfaces read.** `readIngestionAlert` with
   * `prismaIngestionAlertSource` is exactly what the OH integration-health card and the global
   * freshness banner call, so the push and the page can never disagree about whether the pipeline is
   * healthy — which matters more here than anywhere else in the slice, because an operator who is told
   * one thing by a notification and another by the screen will believe neither again.
   *
   * **Deduplicated per (kind, day).** The entity is the pipeline itself — there is one — so the dedup
   * key is the notice type plus the IST day. This is the case the dedup was built for: an outage lasts
   * hours, this tick runs hourly, and a fresh push every hour would train the recipient to mute a
   * channel whose whole value is that it is never noise.
   */
  async sweepIngestionAlerts(now: Date = new Date()): Promise<{ notified: number }> {
    const health = await readIngestionAlert(
      prismaIngestionAlertSource(this.prisma),
      readIngestionStreakThreshold(),
      readIngestionCadence(now),
    );
    const due = dueIngestionNotices(health);
    if (due.length === 0) return { notified: 0 };

    // Resolved inside the transaction below, per #338 — the row records who was told.
    const queued = await this.prisma.$transaction(async (tx) => {
      const recipients = await this.notifications.recipientsInRoles({ role: 'OPERATIONS_HEAD' }, tx);
      if (recipients.length === 0) return [];
      const ids: bigint[] = [];
      for (const kind of due) {
        const id = await queueNoticeOnce(
          tx,
          {
            recipients,
            type: noticeType(kind),
            title: kind === 'OVERDUE' ? 'Ingestion has stopped' : 'Ingestion is failing',
            body: ingestionNoticeBody(kind, health),
            // There is one pipeline, so the entity is the notice's own subject. Constant by design:
            // it is half the dedup key, and a varying id (a run id, say) would let the same outage
            // re-notify on every new failed run — the exact behaviour the dedup exists to stop.
            entityType: 'ingestion',
            entityId: 'telemetry',
            deliveryModel: 'GENERAL',
            metadata: {
              streak: health.streak,
              silenceMinutes: health.silenceMinutes,
              expectedCadenceMinutes: health.expectedCadenceMinutes,
              failingChunk: health.failingChunk,
            },
          },
          now,
        );
        if (id !== null) ids.push(id);
      }
      return ids;
    });

    await drainProducerRows(this.prisma, { notify: this.notifications }, queued, now);
    if (queued.length > 0) this.logger.warn(`ingestion alert: notified Operations Head (${due.join(', ')})`);
    return { notified: queued.length };
  }
}

function noticeType(kind: IngestionNoticeKind): string {
  return kind === 'OVERDUE' ? PRD_NOTICE_TYPES.ingestionSnapshotOverdue : PRD_NOTICE_TYPES.ingestionSnapshotFailed;
}
