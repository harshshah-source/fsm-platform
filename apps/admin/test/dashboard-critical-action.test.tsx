import type { SessionView } from '@fsm/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ActionRequiredCard } from '../src/api/dashboard';
import { AuthProvider } from '../src/auth/AuthProvider';
import { ACTION_REQUIRED_DESTINATIONS } from '../src/lib/actionRequiredDestinations';
import { ActionRequiredPanel } from '../src/pages/dashboard/ActionRequiredPanel';
import { CentralDashboard } from '../src/pages/dashboard/CentralDashboard';
import { OpsHeadDashboard } from '../src/pages/dashboard/OpsHeadDashboard';
import type { DashboardData } from '../src/pages/dashboard/ZmDashboard';

/**
 * Action Required panel — Issue 06 AC#1, completed by **#350**.
 *
 * The Grouped Critical Work Queue this file also covered was retired by #277 and is absorbed into the
 * Assign Work Console's Critical+ preset (`assign-console.test.tsx`).
 *
 * #350 is about two things the panel could not do:
 *
 * 1. **It told the truth about five sources it had never counted.** Five of the nine cards were
 *    permanent `available:false` stubs painting "coming soon". The backend now counts all nine, so the
 *    panel's job here is to stop having a stub rendering at all.
 * 2. **A count is a door, not a poster.** Every card links to the surface that lists its rows, from the
 *    same `ACTION_REQUIRED_DESTINATIONS` map the Scheduler Console's attention band reads — one answer
 *    to "where do I go to do this", not two that drift.
 *
 * The panel was also mounted on the CSM and Ops-Head dashboards, which had none: the ZM alone could see
 * what needed a manager, and the two roles who cover every zone could not.
 */
const cards: ActionRequiredCard[] = [
  { key: 'unreviewed_batches', label: 'Auto-dispatched batches today', urgency: 1, count: 4, available: true, source: 'Issue 11' },
  { key: 'manual_assignment_required', label: 'Manual assignment required', urgency: 2, count: 3, available: true, source: 'Issue 30' },
  { key: 'critical_escalations_pending', label: 'CRITICAL escalations pending manual assignment', urgency: 3, count: 0, available: true, source: 'Issue 29' },
];

const dashboardData: DashboardData = {
  zones: [],
  companyPlants: [],
  critical: [],
  actions: cards,
  fleet: null,
  fleetUptime: null,
  zoneUptime: new Map(),
  plantUptime: new Map(),
  engineers: [],
  error: null,
  onAssigned: () => undefined,
  onDataRefetch: async () => undefined,
};

const renderPanel = (data: ActionRequiredCard[] = cards) =>
  render(
    <MemoryRouter>
      <ActionRequiredPanel cards={data} />
    </MemoryRouter>,
  );

describe('Action Required panel (Issue 06 AC#1 · #350)', () => {
  it('renders cards in urgency order, with their counts', () => {
    renderPanel();

    const items = screen.getAllByTestId('action-card');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(/batches today/i);
    expect(items[1]).toHaveTextContent(/manual assignment/i);
    expect(within(items[0]).getByText('4')).toBeInTheDocument();
    expect(within(items[1]).getByText('3')).toBeInTheDocument();
    // A wired card at zero says zero. It is a fact about the work, not a missing counter.
    expect(within(items[2]).getByText('0')).toBeInTheDocument();
  });

  it('AC4 — no card paints "coming soon"', () => {
    renderPanel();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  it('AC2 — every card is a link to the surface that lists its rows', () => {
    renderPanel();

    const items = screen.getAllByTestId('action-card');
    for (const [i, card] of cards.entries()) {
      const dest = ACTION_REQUIRED_DESTINATIONS[card.key];
      expect(dest, `no destination for ${card.key}`).toBeDefined();
      const link = within(items[i]).getByRole('link');
      expect(link).toHaveAttribute('href', dest!.to);
      // The link names the card, so the destination is announced with its subject, not as "here".
      expect(link).toHaveAccessibleName(new RegExp(card.label.slice(0, 18), 'i'));
    }
  });

  /**
   * The stub branch survives the slice even though nothing renders it today: a tenth card added ahead
   * of its source must still read as *"not counted yet"* and never as a real zero. It just no longer
   * says "coming soon", which read as a product promise rather than a measurement gap.
   */
  it('an unwired source is still distinguishable from a genuine zero', () => {
    renderPanel([{ key: 'future', label: 'Something later', urgency: 1, count: 0, available: false, source: 'Issue 99' }]);
    const card = screen.getByTestId('action-card');
    expect(within(card).queryByText('0')).not.toBeInTheDocument();
    expect(card).toHaveTextContent(/not counted yet/i);
  });
});

const csmSession: SessionView = {
  user_id: 'csm1',
  role: 'CENTRAL_SERVICE_MANAGER',
  zone_id: null,
  acted_as_role: null,
};
const ohSession: SessionView = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null, acted_as_role: null };

describe('#350 AC3 — the CSM and Ops-Head dashboards mount the panel', () => {
  // #351 mounted the cross-zone operating-mode table on both bodies, and it reads `useAuth` to decide
  // whether the viewer may see it — so these two bare renders now need the provider around them.
  it('CentralDashboard renders the Action Required cards', () => {
    render(
      <AuthProvider initialSession={csmSession}>
        <MemoryRouter>
          <CentralDashboard {...dashboardData} />
        </MemoryRouter>
      </AuthProvider>,
    );
    expect(screen.getAllByTestId('action-card')).toHaveLength(3);
  });

  it('OpsHeadDashboard renders the Action Required cards', () => {
    render(
      <AuthProvider initialSession={ohSession}>
        <MemoryRouter>
          <OpsHeadDashboard {...dashboardData} />
        </MemoryRouter>
      </AuthProvider>,
    );
    expect(screen.getAllByTestId('action-card')).toHaveLength(3);
  });
});

/**
 * The destination map is the contract between the dashboard panel and the Console's attention band.
 * A card key with no entry renders as "no queue page yet" on the band — correct when no surface
 * exists, and a silent dead end if a key is simply misspelled.
 */
describe('#350 — action-required destinations', () => {
  it('covers all nine card keys with a route the admin app serves', () => {
    const keys = [
      'unreviewed_batches',
      'vehicle_unavailability',
      'critical_escalations_pending',
      'failed_verification',
      'component_blocked',
      'waiting_component_overdue',
      'non_op_awaiting_manager',
      'manual_assignment_required',
      'recovery_stalled',
    ];
    for (const key of keys) {
      const dest = ACTION_REQUIRED_DESTINATIONS[key];
      expect(dest, `no destination for ${key}`).toBeDefined();
      expect(dest!.to.startsWith('/')).toBe(true);
      expect(dest!.verb.length).toBeGreaterThan(0);
    }
    // §21 retired SE Acceptance — the old key must not survive anywhere.
    expect(ACTION_REQUIRED_DESTINATIONS.critical_insertions_awaiting_accept).toBeUndefined();
  });
});
