import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { DeviceStateService } from '../../device-state/device-state.service';
import {
  AutoRecoveryService,
  readAutoRecoveryMaxPerPass,
  type AutoRecoveryResult,
} from '../../ticketing/auto-recovery.service';
import { TicketCreationService } from '../../ticketing/ticket-creation.service';
import { SnapshotIngestionWorker } from '../snapshot-ingestion.worker';
import { MasterSyncService } from './master-sync.service';

export interface PipelineSummary {
  master: { runId: string; status: string; stats: Record<string, unknown> };
  snapshot: { runId: string; status: string; chunks: number; inserted: number };
  deviceState: { upserted: number; derived: boolean };
  recovered: AutoRecoveryResult;
  tickets: { created: number };
  /**
   * #230 — did the telemetry read for this pass cover the fleet? `false` means the snapshot run did not
   * finalise SUCCESS, so device-state derivation, auto-recovery and ticket creation were all SKIPPED
   * rather than run on partial evidence. A typed field, not a log line: "we chose not to act" and
   * "there was nothing to do" must not look identical downstream (#228 R3).
   */
  ingestComplete: boolean;
}

/** A scheduled tick that found a run already in flight — a normal outcome, not an error. */
export interface TickSkipped {
  skipped: true;
  reason: 'RUN_IN_PROGRESS';
}

export type TelemetryTickResult =
  | TickSkipped
  | {
      skipped: false;
      snapshot: PipelineSummary['snapshot'];
      deviceState: PipelineSummary['deviceState'];
      recovered: PipelineSummary['recovered'];
      tickets: PipelineSummary['tickets'];
      ingestComplete: PipelineSummary['ingestComplete'];
    };

/** The 409 both run guards throw (`{ code: 'RUN_IN_PROGRESS' }`) — anything else must propagate. */
const isRunInProgress = (e: unknown): boolean =>
  e instanceof ConflictException &&
  (e.getResponse() as { code?: string } | null)?.code === 'RUN_IN_PROGRESS';

/**
 * The first-light integration orchestrator — runs the AutoPlant → FSM pipeline end-to-end, in order,
 * so live data reaches the dashboards:
 *
 *   master-sync (org graph, paginated ≤ 90/query)  →  snapshot ingest (telemetry, chunked ≤ 90)
 *     →  device-state recompute (inactivity / sla_bucket / eligibility, denormalised plant/company)
 *     →  auto-recovery pre-check (healthy device + ping evidence → close VERIFIED, #229)
 *     →  ticket creation (newly inactive + eligible + no open cycle → Failure Cycle + Ticket)
 *
 * Each stage owns its own single-in-flight guard and/or idempotency, so a re-run is safe — ticket
 * creation included (the `has_open_failure_cycle` filter + invariant I1 partial-unique make replays
 * and overlaps no-ops). Ticket creation was chained by Issue 112 (review A8); whether it selects any
 * candidates is governed by the `eligibility_mode` setting (review B7), not by this orchestrator.
 *
 * **The recompute → auto-recovery → creation order is load-bearing, not stylistic** (#229). The
 * pre-check's healthy-device filter reads `device_states.is_inactive`, which the stage immediately
 * before it has just rewritten; and running before creation means a device that recovered gets its
 * cycle closed rather than a second one opened on top. Auto-recovery placed *after* creation would be
 * a no-op by construction — creation skips any device with `has_open_failure_cycle`.
 */
@Injectable()
export class IntegrationSyncService {
  private readonly logger = new Logger(IntegrationSyncService.name);

  constructor(
    private readonly masterSync: MasterSyncService,
    private readonly snapshotWorker: SnapshotIngestionWorker,
    private readonly deviceState: DeviceStateService,
    private readonly autoRecovery: AutoRecoveryService,
    private readonly ticketCreation: TicketCreationService,
  ) {}

  /** Master-sync only — refresh the org graph and re-feed the pending zone-mapping queue, no telemetry. */
  async syncMasters(): Promise<PipelineSummary['master']> {
    const master = await this.masterSync.sync();
    this.logger.log(`master-sync ${master.runId} ${master.status}`);
    return { runId: master.runId.toString(), status: master.status, stats: master.stats };
  }

  /**
   * The short-cadence telemetry tick (Issue 97 Slice 6): snapshot ingest + device-state recompute,
   * NO master sync (the org graph refreshes on its own daily cadence). Overlap-safe by design — a
   * tick that finds a run in flight returns `{ skipped: true }` instead of throwing, so back-to-back
   * scheduler ticks degrade to a clean no-op while the in-flight guards keep doing the serializing.
   */
  async ingestTelemetry(opts: { chunkSize?: number } = {}): Promise<TelemetryTickResult> {
    const chunkSize = opts.chunkSize ?? 90;
    const outcome = await this.skipOnOverlap(() => this.snapshotWorker.run({ chunkSize }));
    if (outcome.skipped) return outcome;

    const snap = outcome.value;
    this.logger.log(`telemetry tick: snapshot ${snap.runId} ${snap.status} (${snap.inserted} pings)`);
    // #130 L5 — this path is the @Cron-driven telemetry tick (integration-scheduler.service.ts);
    // stamp the ledger row 'cron' for accurate attribution (runPipeline below stays the 'api' default).
    const staged = await this.runPostIngestStages('telemetry tick', snap.status, 'cron');

    return {
      skipped: false,
      snapshot: {
        runId: snap.runId.toString(),
        status: snap.status,
        chunks: snap.chunks,
        inserted: snap.inserted,
      },
      ...staged,
    };
  }

  /**
   * Everything downstream of the telemetry read — device-state derivation, the auto-recovery
   * pre-check, ticket creation — behind **one** incomplete-ingest gate (#230).
   *
   * A snapshot run that did not finalise `SUCCESS` read only part of the fleet. Every stage below
   * consumes `device_states` as if it described the whole fleet, so running them on a partial read does
   * not degrade gracefully — it fabricates. On 2026-08-10 run 153 aborted after 2,610 of 27,032 devices
   * and this chain aged the unseen 24,422 into `is_inactive`, then opened **3,439 Failure Cycles**, 99.6%
   * of them on devices the read never reached. The open book went 12,571 → 15,057 off a 9.7% read.
   *
   * The gate is the run's own SUCCESS/PARTIAL verdict, which was already correct and already recorded —
   * nothing new had to be measured. What was missing was anyone *consulting* it before writing.
   *
   * Shared by both entry points deliberately: `runPipeline()` is the ungated OH manual trigger (#231),
   * and it is the path that actually fired. A guard on the cron path alone would have prevented nothing.
   */
  private async runPostIngestStages(
    label: string,
    snapshotStatus: string,
    trigger: 'cron' | 'api',
  ): Promise<{
    deviceState: PipelineSummary['deviceState'];
    recovered: PipelineSummary['recovered'];
    tickets: PipelineSummary['tickets'];
    ingestComplete: boolean;
  }> {
    const ingestComplete = snapshotStatus === 'SUCCESS';

    const deviceState = await this.deviceState.recompute(new Date(), trigger, {
      skipDerivation: !ingestComplete,
    });

    if (!ingestComplete) {
      this.logger.warn(
        `${label}: telemetry read finished ${snapshotStatus}, NOT SUCCESS — device-state derivation, ` +
          `auto-recovery and ticket creation all SKIPPED (#230). No Failure Cycle is opened on evidence ` +
          `this pass did not read. Re-run once the source read completes; nothing here needs undoing.`,
      );
      return {
        deviceState,
        recovered: { closed: 0, scanned: 0, examined: 0, skipped: 0, capped: false },
        tickets: { created: 0 },
        ingestComplete,
      };
    }

    this.logger.log(`${label}: device-state recompute upserted ${deviceState.upserted}`);
    const recovered = await this.runAutoRecoveryStage(label);
    const tickets = await this.ticketCreation.createForInactiveEligible();
    this.logger.log(`${label}: ticket-create created ${tickets.created}`);
    return { deviceState, recovered, tickets, ingestComplete };
  }

  /**
   * The auto-recovery pre-check (#229), between device-state recompute and ticket creation exactly as
   * `fsm-backend-low-level-design.md:615` and `fsm-business-technical-workflow.md:512` specify.
   *
   * Shared by both entry points so the two can never drift — the last time this stage existed in one
   * path and not the other it stayed missing for eleven months. The log line reports `closed/scanned`
   * rather than a bare count, and says so when the per-pass cap deferred work: a run that closed 200
   * of 9,000 and a run that closed 200 of 200 are different situations and must not print the same.
   */
  private async runAutoRecoveryStage(label: string): Promise<AutoRecoveryResult> {
    const recovered = await this.autoRecovery.runAutoRecovery({
      maxClosures: readAutoRecoveryMaxPerPass(),
    });
    const deferred = recovered.scanned - recovered.examined;
    this.logger.log(
      `${label}: auto-recovery closed ${recovered.closed}/${recovered.scanned} healthy-device tickets` +
        (recovered.capped ? ` — per-pass cap reached, ${deferred} candidate(s) deferred to the next pass` : ''),
    );
    return recovered;
  }

  /**
   * The scheduled masters entry (Issue 97 Slice 7): `syncMasters()` behind the same overlap-swallow
   * as the telemetry tick, so an overlapping daily tick degrades to a skip. The HTTP trigger keeps
   * calling `syncMasters()` directly and propagating its 409 verbatim.
   */
  async syncMastersTick(): Promise<TickSkipped | { skipped: false; master: PipelineSummary['master'] }> {
    const outcome = await this.skipOnOverlap(() => this.syncMasters());
    if (outcome.skipped) return outcome;
    return { skipped: false, master: outcome.value };
  }

  /**
   * Convert the in-flight guards' 409 into a skip result — shared by every SCHEDULED path (the
   * Slice-7 masters handler reuses this around `syncMasters()`), while the HTTP triggers keep
   * propagating the 409 verbatim to their callers.
   */
  private async skipOnOverlap<T>(work: () => Promise<T>): Promise<TickSkipped | { skipped: false; value: T }> {
    try {
      return { skipped: false, value: await work() };
    } catch (e) {
      if (isRunInProgress(e)) {
        this.logger.log('run already in flight — tick skipped (RUN_IN_PROGRESS)');
        return { skipped: true, reason: 'RUN_IN_PROGRESS' };
      }
      throw e;
    }
  }

  async runPipeline(opts: { chunkSize?: number } = {}): Promise<PipelineSummary> {
    const chunkSize = opts.chunkSize ?? 90;

    const master = await this.syncMasters();
    const snap = await this.snapshotWorker.run({ chunkSize });
    this.logger.log(`snapshot ${snap.runId} ${snap.status} (${snap.inserted} pings)`);
    const staged = await this.runPostIngestStages('pipeline', snap.status, 'api');

    return {
      master,
      snapshot: {
        runId: snap.runId.toString(),
        status: snap.status,
        chunks: snap.chunks,
        inserted: snap.inserted,
      },
      ...staged,
    };
  }
}
