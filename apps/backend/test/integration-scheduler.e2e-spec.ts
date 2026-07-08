import { ConflictException } from '@nestjs/common';
import { vi } from 'vitest';
import type { DeviceStateService } from '../src/device-state/device-state.service';
import {
  DEFAULT_MASTERS_CRON,
  DEFAULT_TELEMETRY_CRON,
  IntegrationSchedulerService,
  readIngestionSchedulerConfig,
  type SchedulerSourceGate,
} from '../src/ingestion/autoplant/integration-scheduler.service';
import { IntegrationSyncService } from '../src/ingestion/autoplant/integration-sync.service';
import type { MasterSyncService } from '../src/ingestion/autoplant/master-sync.service';
import type { SnapshotIngestionWorker } from '../src/ingestion/snapshot-ingestion.worker';

/**
 * Issue 97 Slice 7 (review A1) — the in-process `@nestjs/schedule` scheduler. Two cron handlers:
 * masters (daily, org graph via the overlap-safe `syncMastersTick`) and telemetry (short interval,
 * `ingestTelemetry`). Handlers are invoked manually here (the cron trigger itself is the library's
 * concern); what this slice owns is the dispatch and the guards: env-gated OFF by default
 * (`INGESTION_SCHEDULER_ENABLED`), dormant when AutoPlant is unconfigured (no VPN in dev/test/CI),
 * overlap → logged skip, and a failing tick NEVER throws out of a cron context.
 */
const gate = (configured: boolean): SchedulerSourceGate => ({ isConfigured: () => configured });

describe('Issue 97 Slice 7 — IntegrationSchedulerService', () => {
  const sync = {
    ingestTelemetry: vi.fn(async () => ({ skipped: false as const, snapshot: {}, deviceState: {} })),
    syncMastersTick: vi.fn(async () => ({ skipped: false as const, master: { runId: '1', status: 'SUCCESS', stats: {} } })),
  };

  const makeScheduler = (opts: { enabled: boolean; configured: boolean }): IntegrationSchedulerService =>
    new IntegrationSchedulerService(sync as unknown as IntegrationSyncService, gate(opts.configured), {
      enabled: opts.enabled,
      mastersCron: '0 2 * * *',
      telemetryCron: '*/30 * * * *',
    });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('telemetry tick dispatches to ingestTelemetry when enabled and configured', async () => {
    const outcome = await makeScheduler({ enabled: true, configured: true }).telemetryTick();

    expect(sync.ingestTelemetry).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ ran: true });
  });

  it('masters tick dispatches to the overlap-safe syncMastersTick — never raw syncMasters', async () => {
    const outcome = await makeScheduler({ enabled: true, configured: true }).mastersTick();

    expect(sync.syncMastersTick).toHaveBeenCalledTimes(1);
    expect(sync.ingestTelemetry).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ran: true });
  });

  it('is dormant when the flag is off — no dispatch at all (default posture)', async () => {
    const scheduler = makeScheduler({ enabled: false, configured: true });

    expect(await scheduler.telemetryTick()).toEqual({ ran: false, reason: 'DISABLED' });
    expect(await scheduler.mastersTick()).toEqual({ ran: false, reason: 'DISABLED' });
    expect(sync.ingestTelemetry).not.toHaveBeenCalled();
    expect(sync.syncMastersTick).not.toHaveBeenCalled();
  });

  it('is dormant when AutoPlant is unconfigured — dev/test/CI boot with no VPN', async () => {
    const scheduler = makeScheduler({ enabled: true, configured: false });

    expect(await scheduler.telemetryTick()).toEqual({ ran: false, reason: 'UNCONFIGURED' });
    expect(await scheduler.mastersTick()).toEqual({ ran: false, reason: 'UNCONFIGURED' });
    expect(sync.ingestTelemetry).not.toHaveBeenCalled();
    expect(sync.syncMastersTick).not.toHaveBeenCalled();
  });

  it('logs an overlap as a skip — both handlers report RUN_IN_PROGRESS without throwing', async () => {
    sync.ingestTelemetry.mockResolvedValueOnce({ skipped: true, reason: 'RUN_IN_PROGRESS' } as never);
    sync.syncMastersTick.mockResolvedValueOnce({ skipped: true, reason: 'RUN_IN_PROGRESS' } as never);
    const scheduler = makeScheduler({ enabled: true, configured: true });

    expect(await scheduler.telemetryTick()).toEqual({ ran: false, reason: 'RUN_IN_PROGRESS' });
    expect(await scheduler.mastersTick()).toEqual({ ran: false, reason: 'RUN_IN_PROGRESS' });
  });

  it('a failing tick never throws out of the cron context — logged and reported as ERROR', async () => {
    sync.ingestTelemetry.mockRejectedValueOnce(new Error('VPN died mid-read') as never);
    sync.syncMastersTick.mockRejectedValueOnce(new Error('source exploded') as never);
    const scheduler = makeScheduler({ enabled: true, configured: true });

    expect(await scheduler.telemetryTick()).toEqual({ ran: false, reason: 'ERROR' });
    expect(await scheduler.mastersTick()).toEqual({ ran: false, reason: 'ERROR' });
  });

  it('syncMastersTick swallows the masters 409 (shared skipOnOverlap) — uniform overlap safety', async () => {
    const conflicted = {
      sync: vi.fn(async () => {
        throw new ConflictException({ code: 'RUN_IN_PROGRESS', message: 'in flight' });
      }),
    };
    const service = new IntegrationSyncService(
      conflicted as unknown as MasterSyncService,
      {} as SnapshotIngestionWorker,
      {} as DeviceStateService,
      {} as import('../src/ticketing/ticket-creation.service').TicketCreationService,
    );

    expect(await service.syncMastersTick()).toEqual({ skipped: true, reason: 'RUN_IN_PROGRESS' });
  });

  it('readIngestionSchedulerConfig: OFF by default; crons default and env-override', () => {
    expect(readIngestionSchedulerConfig({})).toEqual({
      enabled: false,
      mastersCron: DEFAULT_MASTERS_CRON,
      telemetryCron: DEFAULT_TELEMETRY_CRON,
    });
    expect(
      readIngestionSchedulerConfig({
        INGESTION_SCHEDULER_ENABLED: 'true',
        INGESTION_MASTERS_CRON: '0 3 * * *',
        INGESTION_TELEMETRY_CRON: '*/15 * * * *',
      }),
    ).toEqual({ enabled: true, mastersCron: '0 3 * * *', telemetryCron: '*/15 * * * *' });
    // Anything but the literal 'true' stays OFF — enabling is a deliberate ops step.
    expect(readIngestionSchedulerConfig({ INGESTION_SCHEDULER_ENABLED: '1' }).enabled).toBe(false);
  });

  it('registers both named cron jobs under ScheduleModule (dormant, but on the clock)', async () => {
    const { Test } = await import('@nestjs/testing');
    const { ScheduleModule, SchedulerRegistry } = await import('@nestjs/schedule');

    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        {
          provide: IntegrationSchedulerService,
          useFactory: () => makeScheduler({ enabled: false, configured: false }),
        },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const jobs = app.get(SchedulerRegistry).getCronJobs();
      expect(jobs.has('ingestion-telemetry')).toBe(true);
      expect(jobs.has('ingestion-masters')).toBe(true);
    } finally {
      await app.close();
    }
  });
});
