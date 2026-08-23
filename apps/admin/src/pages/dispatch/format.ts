// Shared presentation helpers for the Dispatch-Runs transparency drill-down (Issue 123).
import type { BadgeTone } from '../../components/ui/Badge';
import type { DispatchRunListRow, DispatchRunStatus, DispatchZoneMode, PoolEmptyReason } from '../../api/dispatch-runs';

export const STATUS_TONE: Record<DispatchRunStatus, BadgeTone> = {
  SUCCESS: 'success',
  PARTIAL: 'warning',
  FAILED: 'critical',
  RUNNING: 'info',
  // #261 — critical, alongside FAILED. The two mean different things (see DispatchRunStatus) but carry
  // the same urgency: in both cases the day's dispatch did not happen and somebody has to look.
  ABORTED: 'critical',
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

/** Plain-language names for the scoring components captured in a run's priority-rule snapshot. */
const COMPONENT_LABEL: Record<string, string> = {
  companyPriorityRank: 'Customer priority',
  dispatchUrgency: 'SLA urgency',
  repeatFailure: 'Repeat failures',
  inactivityHours: 'Device age / idle',
  age: 'Device age / idle',
  distance: 'Travel distance (not yet used)',
};

export function componentLabel(component: string): string {
  if (COMPONENT_LABEL[component]) return COMPONENT_LABEL[component];
  // Fallback: humanize a raw key (camelCase / snake_case → spaced, capitalized).
  const spaced = component.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** 1 → "1st", 2 → "2nd", 3 → "3rd", 4 → "4th"… for precedence-rank prose. */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Translate the common `m h * * *` daily cron to human time; fall back to the raw expression. */
export function humanizeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5 && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    const min = Number(parts[0]);
    const hour = Number(parts[1]);
    if (Number.isInteger(min) && Number.isInteger(hour)) {
      const h12 = hour % 12 === 0 ? 12 : hour % 12;
      const ampm = hour < 12 ? 'AM' : 'PM';
      return `daily at ${h12}:${String(min).padStart(2, '0')} ${ampm}`;
    }
  }
  return cron;
}
