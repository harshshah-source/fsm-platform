import type { TodayEngineer, TodayTicket } from '../../api/dispatchToday';
import { SLABadge } from '../../components/domain/badges';
import { Badge } from '../../components/ui';
import { LoadBadge } from '../../components/ui/LoadBadge';

/**
 * The provenance grammar, in one place (#282 R2 · shared with #272's chip table).
 *
 * Solid + dot = the engine decided. Dashed = a human did, and the chip says who by role. Heavy
 * crimson = critical work, direct-assigned. `RET` = the vehicle is due back today.
 *
 * The rule that matters most is the one about absence: a ticket written before #283 carries no
 * `addSource`, and unknown provenance is drawn as unknown — never as a system decision. Drawing it
 * solid would be the single lie this whole grammar exists to prevent, so the fallback is the dotted
 * "unknown" treatment, which reads as neither.
 */
function chipTreatment(t: TodayTicket): { className: string; title: string } {
  const critical = t.slaBucket === 'CRITICAL' || t.slaBucket === 'HIGH_CRITICAL';

  if (t.addSource == null) {
    return {
      className: 'border border-dotted border-line text-ink-muted',
      title: 'Provenance not recorded — this assignment predates provenance tracking',
    };
  }
  if (t.systemPlaced) {
    return {
      className: critical
        ? 'border-2 border-critical text-critical font-semibold'
        : 'border border-line text-ink',
      title: critical ? 'System decision — critical, direct-assigned' : 'System decision',
    };
  }
  // A human. Dashed always; violet when they crossed a coverage tier, which is the case #272 R6
  // permits and requires be marked.
  const crossed = t.coverageTypeAtAssign === 'FLOATING' || t.coverageTypeAtAssign === 'NONE';
  return {
    className: crossed
      ? 'border border-dashed border-tier-cross text-tier-cross'
      : 'border border-dashed border-ink-muted text-ink',
    title: crossed
      ? `Human override — coverage at assign: ${t.coverageTypeAtAssign}`
      : 'Human override',
  };
}

function TicketChip({ ticket }: { ticket: TodayTicket }) {
  const { className, title } = chipTreatment(ticket);
  return (
    <span
      title={title}
      data-testid={`chip-${ticket.ticketId}`}
      data-provenance={ticket.addSource ?? 'UNKNOWN'}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] tabular-nums ${className}`}
    >
      {ticket.systemPlaced && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
      {ticket.ticketId.slice(0, 8)}
      {ticket.returnDueToday && (
        <span className="rounded bg-surface-sunken px-1 text-[9px] font-bold tracking-wide" title="Vehicle due back today">
          RET
        </span>
      )}
    </span>
  );
}

/**
 * One engineer's lane.
 *
 * Deliberately ordinal — numbered stops in the order the plan holds them, and no times anywhere.
 * #258 Q6 rules out live GPS in Phase 1 and the approved design says it in its own words ("the
 * journey metaphor is honest — ordinal, no fake clock"), so an ETA here would be invented data.
 */
export function CrewCard({ engineer }: { engineer: TodayEngineer }) {
  const unavailable = engineer.availability !== 'AVAILABLE';
  const ticketCount = engineer.stops.reduce((n, s) => n + s.tickets.length, 0);

  return (
    <article
      data-testid={`crew-card-${engineer.seId}`}
      data-over-capacity={engineer.overCapacity}
      className={[
        'flex flex-col gap-2 rounded-lg border bg-surface p-3',
        engineer.overCapacity ? 'border-warning bg-warning-soft/30' : 'border-line',
      ].join(' ')}
    >
      <header className="flex flex-wrap items-baseline gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{engineer.name}</h3>
        <Badge tone="neutral">{engineer.coverageType.replace('_', ' ')}</Badge>
        <LoadBadge committed={engineer.committed} dailyCapacity={engineer.dailyCapacity} seId={engineer.seId} />
      </header>

      {unavailable && (
        <p className="rounded bg-surface-sunken px-2 py-1 text-[11px] text-ink-muted">
          {engineer.availability.replace(/_/g, ' ').toLowerCase()} — work below still stands on the plan
        </p>
      )}

      {engineer.stops.length === 0 ? (
        <p className="py-2 text-[11px] text-ink-muted">
          {engineer.overCapacity ? 'No stops today.' : 'No stops today — available for work.'}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {engineer.stops.map((stop) => (
            <li key={stop.batchId} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-1.5 text-[11px]">
                <span className="font-mono text-ink-muted">{stop.stopSequence}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{stop.plantName}</span>
                {stop.status === 'OVERRIDDEN' && <Badge tone="warning">adjusted</Badge>}
              </div>
              <div className="flex flex-wrap gap-1 pl-4">
                {stop.tickets.map((t) => (
                  <TicketChip key={t.ticketId} ticket={t} />
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}

      <footer className="mt-auto flex items-center gap-2 border-t border-line pt-1.5 text-[10px] text-ink-muted">
        <span>
          {engineer.stops.length} {engineer.stops.length === 1 ? 'stop' : 'stops'} · {ticketCount}{' '}
          {ticketCount === 1 ? 'device' : 'devices'}
        </span>
        {engineer.stops.length > 0 && engineer.committed < engineer.dailyCapacity && (
          <span className="ml-auto">{engineer.dailyCapacity - engineer.committed} slots free</span>
        )}
      </footer>
    </article>
  );
}

/** The legend. Rendered on the surface, because a grammar nobody can read is decoration. */
export function ProvenanceLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-muted">
      <li className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
          solid
        </span>
        system decision
      </li>
      <li className="flex items-center gap-1.5">
        <span className="rounded border border-dashed border-ink-muted px-1.5 py-0.5">dashed</span>
        human override
      </li>
      <li className="flex items-center gap-1.5">
        <span className="rounded border border-dashed border-tier-cross px-1.5 py-0.5 text-tier-cross">
          dashed violet
        </span>
        a human crossed a coverage tier
      </li>
      <li className="flex items-center gap-1.5">
        <span className="rounded border-2 border-critical px-1.5 py-0.5 text-critical">heavy</span>
        critical, direct-assigned
      </li>
      <li className="flex items-center gap-1.5">
        <span className="rounded border border-dotted border-line px-1.5 py-0.5">dotted</span>
        provenance not recorded
      </li>
    </ul>
  );
}
