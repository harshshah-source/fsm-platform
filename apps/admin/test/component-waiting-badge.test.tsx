import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TicketRow } from '../src/api/tickets';
import { InlineBadges } from '../src/pages/tickets/ticketBadges';

/**
 * Issue 23 — the Ticket List WAITING_COMPONENT flag (AC#4). The inline badge now shows the days
 * elapsed since the SLA paused and the latest Component Request status, so a manager can see at a
 * glance how long a ticket has been stuck on a part and where the request stands.
 */
const base: TicketRow = {
  ticketId: 't1', workType: 'TROUBLESHOOT', status: 'OPEN', deviceId: '1', plantId: '1', companyId: '1',
  companyTier: 'GOLD', assignmentState: 'UNASSIGNED', slaBucket: 'CRITICAL', repeatFailure: false,
  failureCycleState: 'WAITING_COMPONENT', createdAt: '2026-06-20T00:00:00Z',
  componentRequestStatus: 'SHIPPED', waitingComponentSince: new Date(Date.now() - 3 * 86_400_000).toISOString(),
};

describe('WAITING_COMPONENT inline badge (Issue 23)', () => {
  it('shows days elapsed and the component-request status', () => {
    render(<InlineBadges ticket={base} />);
    const badge = screen.getByTestId('badge-WAITING_COMPONENT');
    expect(badge).toHaveTextContent(/WAITING COMPONENT/i);
    expect(badge).toHaveTextContent(/3d/);
    expect(badge).toHaveTextContent(/SHIPPED/);
  });

  it('renders the plain badge when no pause timestamp or request status is present', () => {
    render(<InlineBadges ticket={{ ...base, waitingComponentSince: null, componentRequestStatus: null }} />);
    const badge = screen.getByTestId('badge-WAITING_COMPONENT');
    expect(badge).toHaveTextContent(/WAITING COMPONENT/i);
    expect(badge).not.toHaveTextContent(/SHIPPED/);
  });
});
