import { vi } from 'vitest';
import type { DeviceStateService } from '../src/device-state/device-state.service';
import { IntegrationSyncService } from '../src/ingestion/autoplant/integration-sync.service';
import type { MasterSyncService } from '../src/ingestion/autoplant/master-sync.service';
import type { SnapshotIngestionWorker } from '../src/ingestion/snapshot-ingestion.worker';
import type { AutoRecoveryService } from '../src/ticketing/auto-recovery.service';
import type { TicketCreationService } from '../src/ticketing/ticket-creation.service';

/**
 * Issue 112 Slice B — the pipeline no longer ends one stage early (review A8): ticket creation is
 * chained AFTER device-state recompute on both the telemetry tick and the full pipeline, and its
 * created count surfaces in the results. Fakes at the service seam, mirroring the scheduler spec.
 *
 * **#229** extends this to the stage 112 did not chain: the auto-recovery pre-check, which the LLD
 * (`fsm-backend-low-level-design.md:615`) places between recompute and creation. The **order** is the
 * assertion that matters, not merely the presence of the call — auto-recovery after creation is a
 * no-op by construction, and auto-recovery before recompute would read a stale `is_inactive`. Both
 * entry points are covered because the last time a stage existed in one path and not the other, the
 * gap survived eleven months.
 */
describe('Issue 112 Slice B / #229 — ticket creation and the auto-recovery pre-check in the pipeline', () => {
  const calls: string[] = [];

  const masterSync = {
    sync: vi.fn(async () => {
      calls.push('master');
      return { runId: 7n, status: 'SUCCESS', stats: {} };
    }),
  } as unknown as MasterSyncService;

  let snapshotStatus = 'SUCCESS';

  const snapshotWorker = {
    run: vi.fn(async () => {
      calls.push('snapshot');
      return { runId: 42n, status: snapshotStatus, chunks: 3, inserted: 12 };
    }),
  } as unknown as SnapshotIngestionWorker;

  const deviceState = {
    recompute: vi.fn(async (_now?: Date, _t?: string, opts?: { skipDerivation?: boolean }) => {
      calls.push(opts?.skipDerivation ? 'recompute(skipped)' : 'recompute');
      return { upserted: opts?.skipDerivation ? 0 : 5, derived: !opts?.skipDerivation };
    }),
  } as unknown as DeviceStateService;

  const autoRecovery = {
    runAutoRecovery: vi.fn(async () => {
      calls.push('auto-recovery');
      return { closed: 3, scanned: 9, examined: 9, capped: false };
    }),
  } as unknown as AutoRecoveryService;

  const ticketCreation = {
    createForInactiveEligible: vi.fn(async () => {
      calls.push('ticket-create');
      return { created: 2 };
    }),
  } as unknown as TicketCreationService;

  const makeService = () =>
    new IntegrationSyncService(masterSync, snapshotWorker, deviceState, autoRecovery, ticketCreation);

  beforeEach(() => {
    calls.length = 0;
    snapshotStatus = 'SUCCESS';
    vi.clearAllMocks();
  });

  it('telemetry tick runs recovery between recompute and creation, and reports both counts', async () => {
    const result = await makeService().ingestTelemetry();

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.tickets).toEqual({ created: 2 });
    expect(result.recovered).toMatchObject({ closed: 3, scanned: 9, capped: false });
    expect(calls).toEqual(['snapshot', 'recompute', 'auto-recovery', 'ticket-create']);
  });

  it('run-pipeline chains all five stages in order and reports both counts', async () => {
    const summary = await makeService().runPipeline();

    expect(summary.tickets).toEqual({ created: 2 });
    expect(summary.recovered).toMatchObject({ closed: 3 });
    expect(calls).toEqual(['master', 'snapshot', 'recompute', 'auto-recovery', 'ticket-create']);
  });

  it('passes a per-pass closure cap, so a first drain against the backlog is bounded and resumable', async () => {
    await makeService().ingestTelemetry();

    expect(autoRecovery.runAutoRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ maxClosures: expect.any(Number) }),
    );
  });

  /**
   * #230 — the regression that opened 3,439 Failure Cycles off a 9.7% telemetry read. A snapshot run
   * that did not finalise SUCCESS read only part of the fleet, and every stage below it treats
   * `device_states` as describing the whole fleet. The chain must refuse, not degrade.
   */
  describe('#230 — an incomplete telemetry read must not drive any downstream write', () => {
    it('telemetry tick: PARTIAL ingest skips derivation, auto-recovery AND ticket creation', async () => {
      snapshotStatus = 'PARTIAL';

      const result = await makeService().ingestTelemetry();

      expect(result.skipped).toBe(false);
      if (result.skipped) return;
      expect(result.ingestComplete).toBe(false);
      // Not merely "created 0" by accident — the stages were never reached.
      expect(autoRecovery.runAutoRecovery).not.toHaveBeenCalled();
      expect(ticketCreation.createForInactiveEligible).not.toHaveBeenCalled();
      expect(calls).toEqual(['snapshot', 'recompute(skipped)']);
      // Derivation is skipped so is_inactive/sla_bucket keep last-good values and computed_at lags.
      expect(result.deviceState).toEqual({ upserted: 0, derived: false });
      expect(result.tickets).toEqual({ created: 0 });
    });

    it('run-pipeline (the ungated OH trigger, #231) is gated identically — it is the path that fired', async () => {
      snapshotStatus = 'PARTIAL';

      const summary = await makeService().runPipeline();

      expect(summary.ingestComplete).toBe(false);
      expect(ticketCreation.createForInactiveEligible).not.toHaveBeenCalled();
      expect(autoRecovery.runAutoRecovery).not.toHaveBeenCalled();
      expect(calls).toEqual(['master', 'snapshot', 'recompute(skipped)']);
    });

    it('FAILED is refused too — only SUCCESS is a complete read', async () => {
      snapshotStatus = 'FAILED';

      const result = await makeService().ingestTelemetry();

      expect(result.skipped).toBe(false);
      if (result.skipped) return;
      expect(result.ingestComplete).toBe(false);
      expect(ticketCreation.createForInactiveEligible).not.toHaveBeenCalled();
    });

    it('a SUCCESS ingest still runs everything — the gate is not a blanket off-switch', async () => {
      const result = await makeService().ingestTelemetry();

      expect(result.skipped).toBe(false);
      if (result.skipped) return;
      expect(result.ingestComplete).toBe(true);
      expect(result.deviceState).toEqual({ upserted: 5, derived: true });
      expect(calls).toEqual(['snapshot', 'recompute', 'auto-recovery', 'ticket-create']);
    });
  });
});
