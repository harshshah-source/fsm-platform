import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { DeviceStateService } from '../../device-state/device-state.service';
import { TicketCreationService } from '../../ticketing/ticket-creation.service';
import { SnapshotIngestionWorker } from '../snapshot-ingestion.worker';
import { MasterSyncService } from './master-sync.service';

export interface PipelineSummary {
  master: { runId: string; status: string; stats: Record<string, unknown> };
  snapshot: { runId: string; status: string; chunks: number; inserted: number };
  deviceState: { upserted: number };
  tickets: { created: number };
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
      tickets: PipelineSummary['tickets'];
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
 *     →  ticket creation (newly inactive + eligible + no open cycle → Failure Cycle + Ticket)
 *
 * Each stage owns its own single-in-flight guard and/or idempotency, so a re-run is safe — ticket
 * creation included (the `has_open_failure_cycle` filter + invariant I1 partial-unique make replays
 * and overlaps no-ops). Ticket creation was chained by Issue 112 (review A8); whether it selects any
 * candidates is governed by the `eligibility_mode` setting (review B7), not by this orchestrator.
 */
@Injectable()
export class IntegrationSyncService {
  private readonly logger = new Logger(IntegrationSyncService.name);

  constructor(
    private readonly masterSync: MasterSyncService,
    private readonly snapshotWorker: SnapshotIngestionWorker,
    private readonly deviceState: DeviceStateService,
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
    const deviceState = await this.deviceState.recompute(new Date(), 'cron');
    this.logger.log(`telemetry tick: device-state recompute upserted ${deviceState.upserted}`);
    const tickets = await this.ticketCreation.createForInactiveEligible();
    this.logger.log(`telemetry tick: ticket-create created ${tickets.created}`);

    return {
      skipped: false,
      snapshot: {
        runId: snap.runId.toString(),
        status: snap.status,
        chunks: snap.chunks,
        inserted: snap.inserted,
      },
      deviceState,
      tickets,
    };
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
    const deviceState = await this.deviceState.recompute();
    this.logger.log(`device-state recompute upserted ${deviceState.upserted}`);
    const tickets = await this.ticketCreation.createForInactiveEligible();
    this.logger.log(`ticket-create created ${tickets.created}`);

    return {
      master,
      snapshot: {
        runId: snap.runId.toString(),
        status: snap.status,
        chunks: snap.chunks,
        inserted: snap.inserted,
      },
      deviceState,
      tickets,
    };
  }
}
