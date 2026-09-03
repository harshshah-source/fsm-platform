import { useMemo } from 'react';
import type { CriticalQueueGroup } from '../../api/dashboard';
import { DurationBadge, PlantName, TierBadge } from '../../components/domain';
import { SLA_BUCKETS, type SlaBucket } from '../../lib/slaBucket';

/** Severity rank of a bucket; unknown buckets sort last. */
const severity = (b: string) => {
  const i = SLA_BUCKETS.indexOf(b as SlaBucket);
  return i === -1 ? SLA_BUCKETS.length : i;
};

interface EscalationCluster extends CriticalQueueGroup {
  /** Severity rank of the group's worst ticket — what puts one outage above another. */
  worst: number;
}

/**
 * Order the clusters the way a Central manager triages them: worst bucket first, then biggest
 * cluster, then company name so the ordering is stable across refetches. Tickets inside a cluster
 * keep the same worst-first rule.
 */
function toClusters(groups: CriticalQueueGroup[]): EscalationCluster[] {
  return groups
    .map((g) => ({
      ...g,
      tickets: [...g.tickets].sort((a, b) => severity(a.slaBucket) - severity(b.slaBucket)),
      worst: g.tickets.reduce<number>((w, t) => Math.min(w, severity(t.slaBucket)), SLA_BUCKETS.length),
    }))
    .sort(
      (a, b) =>
        a.worst - b.worst ||
        b.tickets.length - a.tickets.length ||
        a.companyName.localeCompare(b.companyName) ||
        a.plantName.localeCompare(b.plantName),
    );
}

/**
 * Escalation Queue (FE-07, reference 03 Central Tower) — the cross-zone feed of CRITICAL+ work derived
 * from the existing `critical-queue` aggregation. No new endpoint.
 *
 * **#351 AC4 — the grouping the backend already supplies is kept.** This list used to `flatMap` the
 * company/plant groups into a flat row list and sort by bucket, which threw away the one thing the
 * aggregation exists to carry: `clusterSize`. Eight devices silent at a single plant is *one* site
 * problem an SE clears in one visit; flattened, it read as eight unrelated escalations scattered
 * through a list, and the operator's next move — send someone to that plant — was invisible.
 *
 * Rows keep their exact previous anatomy (device, tier, company/plant, duration badge) so the page
 * still reads like reference 03; what changed is that the company and plant are named **once, on the
 * cluster**, and the cluster carries its own count.
 */
export function EscalationQueueList({ groups }: { groups: CriticalQueueGroup[] }) {
  const clusters = useMemo(() => toClusters(groups), [groups]);
  const total = clusters.reduce((n, c) => n + c.tickets.length, 0);

  return (
    <section aria-labelledby="escalation-queue-heading" className="mb-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h3
          id="escalation-queue-heading"
          className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
        >
          Escalation Queue
        </h3>
        <span className="text-xs text-ink-muted">
          {total} open
          {clusters.length > 0 && ` across ${clusters.length} site${clusters.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {clusters.length === 0 ? (
        <p className="rounded-card border border-line bg-surface-card px-4 py-6 text-center text-sm text-ink-muted shadow-sm">
          No cross-zone escalations.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {clusters.map((c) => (
            <section
              key={`${c.companyId}:${c.plantId}`}
              data-testid="escalation-group"
              aria-label={`${c.companyName} — ${c.plantName}`}
            >
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-semibold text-ink-strong">{c.companyName}</span>
                  <TierBadge tier={c.companyTier} />
                  <span className="truncate text-xs text-ink-muted">
                    <PlantName code={c.plantName} variant="inline" />
                  </span>
                </div>
                {/* The cluster-size signal itself: how much of this list one visit clears. */}
                <span
                  data-testid="escalation-cluster-size"
                  className="shrink-0 rounded-full bg-critical-bg px-2 py-0.5 text-[0.68rem] font-semibold uppercase tracking-wide text-critical ring-1 ring-inset ring-critical/10 tabular-nums"
                >
                  {c.clusterSize} at this site
                </span>
              </div>
              <ul className="flex flex-col gap-2">
                {c.tickets.map((t) => (
                  <li
                    key={t.ticketId}
                    data-testid="escalation-item"
                    className="flex items-center justify-between gap-3 rounded-card border border-line border-l-2 border-l-critical bg-surface-card px-4 py-3 shadow-sm"
                  >
                    <div className="min-w-0">
                      <span className="text-sm font-semibold text-ink-strong">Device {t.deviceId}</span>
                    </div>
                    <DurationBadge bucket={t.slaBucket} latestGpsDatetime={t.latestGpsDatetime} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
