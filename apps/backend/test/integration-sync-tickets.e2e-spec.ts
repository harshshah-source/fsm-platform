import { vi } from 'vitest';
import type { DeviceStateService } from '../src/device-state/device-state.service';
import { IntegrationSyncService } from '../src/ingestion/autoplant/integration-sync.service';
import type { MasterSyncService } from '../src/ingestion/autoplant/master-sync.service';
import type { SnapshotIngestionWorker } from '../src/ingestion/snapshot-ingestion.worker';
import type { TicketCreationService } from '../src/ticketing/ticket-creation.service';

/**
 * Issue 112 Slice B — the pipeline no longer ends one stage early (review A8): ticket creation is
 * chained AFTER device-state recompute on both the telemetry tick and the full pipeline, and its
 * created count surfaces in the results. Fakes at the service seam, mirroring the scheduler spec.
 */
describe('Issue 112 Slice B — ticket creation chained into the pipeline', () => {
  const calls: string[] = [];

  const masterSync = {
    sync: vi.fn(async () => {
      calls.push('master');
      return { runId: 7n, status: 'SUCCESS', stats: {} };
    }),
  } as unknown as MasterSyncService;

  const snapshotWorker = {
    run: vi.fn(async () => {
      calls.push('snapshot');
      return { runId: 42n, status: 'SUCCESS', chunks: 3, inserted: 12 };
    }),
  } as unknown as SnapshotIngestionWorker;

  const deviceState = {
    recompute: vi.fn(async () => {
      calls.push('recompute');
      return { upserted: 5 };
    }),
  } as unknown as DeviceStateService;

  const ticketCreation = {
    createForInactiveEligible: vi.fn(async () => {
      calls.push('ticket-create');
      return { created: 2 };
    }),
  } as unknown as TicketCreationService;

  const makeService = () =>
    new IntegrationSyncService(masterSync, snapshotWorker, deviceState, ticketCreation);

  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
  });

  it('telemetry tick runs ticket creation after recompute and reports the created count', async () => {
    const result = await makeService().ingestTelemetry();

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.tickets).toEqual({ created: 2 });
    expect(calls).toEqual(['snapshot', 'recompute', 'ticket-create']);
  });

  it('run-pipeline chains all four stages in order and reports the created count', async () => {
    const summary = await makeService().runPipeline();

    expect(summary.tickets).toEqual({ created: 2 });
    expect(calls).toEqual(['master', 'snapshot', 'recompute', 'ticket-create']);
  });
});
