import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { TickClaimant } from '../../scheduling/cron-tick-claim';
import { IntegrationSyncService } from './integration-sync.service';

/**
 * The minimal slice of `AutoPlantMysqlClient` the scheduler gates on — same pattern as
 * `AutoPlantProbe`. Unconfigured (dev/test/CI, no VPN) ⇒ every tick is a dormant no-op.
 */
export interface SchedulerSourceGate {
  isConfigured(): boolean;
}

export interface IngestionSchedulerConfig {
  /** Master switch — `INGESTION_SCHEDULER_ENABLED === 'true'`. Default OFF (enabling is an ops step). */
  enabled: boolean;
  mastersCron: string;
  telemetryCron: string;
}

/** Daily off-hours org-graph refresh (blueprint cadence; review A1). */
export const DEFAULT_MASTERS_CRON = '0 2 * * *';
/** Telemetry + device-state recompute — 30 min, comfortably above the recompute run time (risk A7). */
export const DEFAULT_TELEMETRY_CRON = '*/30 * * * *';

/** #263 — the registered cron-job names, shared by the decorators and the tick claims. */
export const INGESTION_TELEMETRY_JOB_NAME = 'ingestion-telemetry';
export const INGESTION_MASTERS_JOB_NAME = 'ingestion-masters';

/** The two ops knobs + enable flag in one place (the issue's REFACTOR step, done up front). */
export function readIngestionSchedulerConfig(env: NodeJS.ProcessEnv = process.env): IngestionSchedulerConfig {
  return {
    enabled: env.INGESTION_SCHEDULER_ENABLED === 'true',
    mastersCron: env.INGESTION_MASTERS_CRON?.trim() || DEFAULT_MASTERS_CRON,
    telemetryCron: env.INGESTION_TELEMETRY_CRON?.trim() || DEFAULT_TELEMETRY_CRON,
  };
}

/** What a manually-invokable cron handler reports — a tick NEVER throws out of a cron context. */
export type SchedulerTickOutcome =
  | { ran: true }
  | { ran: false; reason: 'DISABLED' | 'UNCONFIGURED' | 'RUN_IN_PROGRESS' | 'TICK_CLAIMED' | 'ERROR' };

/**
 * In-process ingestion scheduler (Issue 97 Slice 7 / review A1) — the piece that turns the pipeline
 * from "runs when a human presses the button" into a self-running subsystem. Two cron handlers:
 * masters daily (org graph, overlap-safe `syncMastersTick`) and telemetry short-interval
 * (`ingestTelemetry`). The single-in-flight guards remain the serialization mechanism — an overlap
 * surfaces as a logged RUN_IN_PROGRESS skip, never a throw.
 *
 * Cron expressions are resolved from env ONCE at module load (decorator evaluation); the
 * enabled/configured gate is re-checked on EVERY tick, so flipping the env flag requires a restart
 * but a mid-flight VPN loss simply fails that tick fast (Slice 1) and the next one retries.
 */
@Injectable()
export class IntegrationSchedulerService {
  private readonly logger = new Logger(IntegrationSchedulerService.name);
  private readonly config: IngestionSchedulerConfig;

  constructor(
    private readonly sync: IntegrationSyncService,
    private readonly gate: SchedulerSourceGate,
    private readonly claims: TickClaimant,
    config?: IngestionSchedulerConfig,
  ) {
    this.config = config ?? readIngestionSchedulerConfig();
  }

  /** enabled flag AND a configured AutoPlant source — otherwise the scheduler is dormant. */
  private dormantReason(): 'DISABLED' | 'UNCONFIGURED' | null {
    if (!this.config.enabled) return 'DISABLED';
    if (!this.gate.isConfigured()) return 'UNCONFIGURED';
    return null;
  }

  @Cron(readIngestionSchedulerConfig().telemetryCron, { name: INGESTION_TELEMETRY_JOB_NAME })
  async telemetryTick(firedAt: Date = new Date()): Promise<SchedulerTickOutcome> {
    const dormant = this.dormantReason();
    if (dormant) return { ran: false, reason: dormant };
    try {
      // #263 — claimed AFTER the dormant gate, so an instance with no AutoPlant route (dev, CI, a box
      // that lost the VPN) never takes a window it cannot serve and silences the instance that can.
      if (!(await this.claims.claimTickOrLog(INGESTION_TELEMETRY_JOB_NAME, firedAt))) {
        return { ran: false, reason: 'TICK_CLAIMED' };
      }
      const result = await this.sync.ingestTelemetry();
      if (result.skipped) {
        this.logger.log('telemetry tick skipped — run already in flight');
        return { ran: false, reason: result.reason };
      }
      return { ran: true };
    } catch (e) {
      this.logger.error(`telemetry tick failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: false, reason: 'ERROR' };
    }
  }

  @Cron(readIngestionSchedulerConfig().mastersCron, { name: INGESTION_MASTERS_JOB_NAME })
  async mastersTick(firedAt: Date = new Date()): Promise<SchedulerTickOutcome> {
    const dormant = this.dormantReason();
    if (dormant) return { ran: false, reason: dormant };
    try {
      if (!(await this.claims.claimTickOrLog(INGESTION_MASTERS_JOB_NAME, firedAt))) {
        return { ran: false, reason: 'TICK_CLAIMED' };
      }
      const result = await this.sync.syncMastersTick();
      if (result.skipped) {
        this.logger.log('masters tick skipped — run already in flight');
        return { ran: false, reason: result.reason };
      }
      return { ran: true };
    } catch (e) {
      this.logger.error(`masters tick failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: false, reason: 'ERROR' };
    }
  }
}
