import type { CriticalQueueGroup } from '../../api/dashboard';
import { SLABadge, TierBadge } from '../../components/domain';
import { SLA_BUCKETS, type SlaBucket } from '../../lib/slaBucket';

interface EscalationItem {
  ticketId: string;
  deviceId: string;
  slaBucket: string;
  companyName: string;
  companyTier: string;
  plantName: string;
}

/** Flatten the critical clusters into individual escalation rows, most-severe bucket first. */
function toItems(groups: CriticalQueueGroup[]): EscalationItem[] {
  const severity = (b: string) => {
    const i = SLA_BUCKETS.indexOf(b as SlaBucket);
    return i === -1 ? SLA_BUCKETS.length : i; // unknown buckets sort last
  };
  return groups
    .flatMap((g) =>
      g.tickets.map((t) => ({
        ticketId: t.ticketId,
        deviceId: t.deviceId,
        slaBucket: t.slaBucket,
        companyName: g.companyName,
        companyTier: g.companyTier,
        plantName: g.plantName,
      })),
    )
    .sort((a, b) => severity(a.slaBucket) - severity(b.slaBucket));
}

/**
 * Escalation Queue (FE-07, reference 03 Central Tower). The cross-zone feed of CRITICAL+ work derived
 * from the existing `critical-queue` aggregation — no new endpoint. Each row carries the device, its
 * SLA bucket, and the owning company (tier) / plant so a Central manager can triage across zones.
 */
export function EscalationQueueList({ groups }: { groups: CriticalQueueGroup[] }) {
  const items = toItems(groups);

  return (
    <section aria-labelledby="escalation-queue-heading" className="mb-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h3
          id="escalation-queue-heading"
          className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
        >
          Escalation Queue
        </h3>
        <span className="text-xs text-ink-muted">{items.length} open</span>
      </div>
      {items.length === 0 ? (
        <p className="rounded-card border border-line bg-surface-card px-4 py-6 text-center text-sm text-ink-muted shadow-sm">
          No cross-zone escalations.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((it) => (
            <li
              key={it.ticketId}
              data-testid="escalation-item"
              className="flex items-center justify-between gap-3 rounded-card border border-line border-l-2 border-l-critical bg-surface-card px-4 py-3 shadow-sm"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-ink-strong">Device {it.deviceId}</span>
                  <TierBadge tier={it.companyTier} />
                </div>
                <div className="mt-0.5 truncate text-xs text-ink-muted">
                  {it.companyName} · {it.plantName}
                </div>
              </div>
              <SLABadge bucket={it.slaBucket} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
