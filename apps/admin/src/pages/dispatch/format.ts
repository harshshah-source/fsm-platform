// Shared presentation helpers for the Dispatch-Runs transparency drill-down (Issue 123).
import type { BadgeTone } from '../../components/ui/Badge';
import type { DispatchRunListRow, DispatchRunStatus, DispatchZoneMode, PoolEmptyReason } from '../../api/dispatch-runs';

export const STATUS_TONE: Record<DispatchRunStatus, BadgeTone> = {
  SUCCESS: 'success',
  PARTIAL: 'warning',
  FAILED: 'critical',
  RUNNING: 'info',
};

export const MODE_TONE: Record<DispatchZoneMode, BadgeTone> = {
  DEFICIT: 'critical',
  PREVENTIVE: 'info',
};

/** NO_COVERAGE = an Ops coverage gap (no eligible SE at all); ALL_DROPPED = filters emptied the pool. */
export const POOL_EMPTY_LABEL: Record<PoolEmptyReason, string> = {
  NO_COVERAGE: 'No coverage',
  ALL_DROPPED: 'All candidates dropped',
};

/** Compact run duration: sub-minute in seconds, otherwise `Xm Ys`. */
export function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "Automatic" for CRON; "Manual — Name (Role)" for a manager-triggered run. */
export function triggerActor(run: Pick<DispatchRunListRow, 'trigger' | 'actorName' | 'actorRole'>): string {
  if (run.trigger === 'CRON') return 'Automatic';
  const who = run.actorName ?? run.actorRole ?? 'a manager';
  return `Manual — ${who}`;
}

/** A run used code-default weighting when no DB priority-rule rows were captured in its snapshot. */
export function weightsAreDefault(priorityRules: { weightSetRef: string }[]): boolean {
  return priorityRules.length === 0;
}
