import type { TicketRow } from '../../api/tickets';
import { SLABadge } from '../../components/domain/badges';

/**
 * Colour-coded SLA bucket badge (AC#2/#5). Now a thin wrapper over the shared `SLABadge` (FE-04),
 * which keeps the `data-testid="bucket-<BUCKET>"` contract. Null bucket (ACTIVE) renders nothing.
 */
export function BucketBadge({ bucket }: { bucket: string | null }) {
  return <SLABadge bucket={bucket} />;
}

/**
 * Inline condition badges (AC#3). Renders the badges whose data exists today; PARTIAL_RECOVERY
 * (N/3 pings → Issue 18) and FRAUD FLAG (distance delta → Issue 19) appear once their data lands.
 */
export function InlineBadges({ ticket }: { ticket: TicketRow }) {
  const badges: JSX.Element[] = [];
  if (ticket.repeatFailure)
    badges.push(
      <span key="repeat" data-testid="badge-REPEAT" className="rounded bg-orange-100 px-1 text-xs text-orange-800">
        🔥 REPEAT
      </span>,
    );
  if (ticket.status === 'ESCALATED' || ticket.failureCycleState === 'ESCALATED')
    badges.push(
      <span key="esc" data-testid="badge-ESCALATED" className="rounded bg-red-100 px-1 text-xs text-red-800">
        ESCALATED
      </span>,
    );
  if (ticket.failureCycleState === 'WAITING_COMPONENT') {
    const days = ticket.waitingComponentSince
      ? Math.floor((Date.now() - new Date(ticket.waitingComponentSince).getTime()) / 86_400_000)
      : null;
    // Past the 7-day auto-escalation threshold the badge darkens (CONTEXT §8 / Issue 23).
    const overdue = days !== null && days > 7;
    const parts = ['WAITING COMPONENT'];
    if (days !== null) parts.push(`${days}d`);
    if (ticket.componentRequestStatus) parts.push(ticket.componentRequestStatus);
    badges.push(
      <span
        key="wait"
        data-testid="badge-WAITING_COMPONENT"
        className={`rounded px-1 text-xs ${overdue ? 'bg-amber-200 text-amber-900' : 'bg-amber-100 text-amber-800'}`}
      >
        {parts.join(' · ')}
      </span>,
    );
  }
  if (ticket.status === 'CLOSED_AUTO_RECOVERY')
    badges.push(
      <span key="auto" data-testid="badge-AUTO_RECOVERY" className="rounded bg-slate-200 px-1 text-xs text-slate-600">
        auto
      </span>,
    );
  return <span className="flex flex-wrap gap-1">{badges}</span>;
}
