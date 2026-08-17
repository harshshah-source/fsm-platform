import type { TicketRow } from '../../api/tickets';
import { DurationBadge } from '../../components/domain/badges';

/**
 * Per-device inactivity badge (AC#2/#5 · Issue 3). Wraps the shared {@link DurationBadge}: same
 * severity colour + `data-testid="bucket-<BUCKET>"` contract, but the text is the actual elapsed
 * inactive duration since the device's last GPS ping (falls back to the bucket label when the ticket
 * carries no timestamp). Null bucket (ACTIVE) renders nothing.
 */
export function BucketBadge({
  bucket,
  latestGpsDatetime,
}: {
  bucket: string | null;
  latestGpsDatetime?: string | null;
}) {
  return <DurationBadge bucket={bucket} latestGpsDatetime={latestGpsDatetime} />;
}

/**
 * Inline condition badges (AC#3). Renders the badges whose data exists today; PARTIAL_RECOVERY
 * (N/3 pings → Issue 18) and FRAUD FLAG (distance delta → Issue 19) appear once their data lands.
 */
export function InlineBadges({
  ticket,
  assignmentThresholdHours,
}: {
  ticket: TicketRow;
  /** #238 — the live SE-assignment threshold, when the page has it. Undefined ⇒ no badge, never a
   *  guessed one: a wrong "held" flag is worse than no flag. */
  assignmentThresholdHours?: number | null;
}) {
  const badges: JSX.Element[] = [];
  // #238 — auto-dispatch is holding this ticket back. Shown, not enforced: the threshold gates the
  // engine, and a ZM/CSM/OH assigning intraday keeps their judgement (a Platinum customer on the phone
  // outranks a grace window). The badge exists so that judgement is exercised knowingly rather than
  // against a queue that silently disagrees with the dispatch run.
  if (
    ticket.assignmentState === 'UNASSIGNED' &&
    assignmentThresholdHours != null &&
    ticket.inactivityHours != null &&
    ticket.inactivityHours < assignmentThresholdHours
  ) {
    badges.push(
      <span
        key="below-threshold"
        data-testid="badge-BELOW_ASSIGNMENT_THRESHOLD"
        title={`Silent ${Math.floor(ticket.inactivityHours)} h; auto-dispatch starts at ${assignmentThresholdHours} h. You can still assign it manually.`}
        className="rounded bg-neutral-bg px-1 text-xs text-neutral"
      >
        HELD · {Math.floor(ticket.inactivityHours)}/{assignmentThresholdHours}h
      </span>,
    );
  }
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
      <span key="auto" data-testid="badge-AUTO_RECOVERY" className="rounded bg-neutral-bg px-1 text-xs text-neutral">
        auto
      </span>,
    );
  return <span className="flex flex-wrap gap-1">{badges}</span>;
}
