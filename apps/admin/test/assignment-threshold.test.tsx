import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssignmentThresholdSection } from '../src/pages/settings/AssignmentThresholdSection';
import { InlineBadges } from '../src/pages/tickets/ticketBadges';
import { buildNav } from '../src/components/shell/nav';
import type { TicketRow } from '../src/api/tickets';

/**
 * #238 admin — the SE-assignment threshold, co-owned by the Operations Head and the CSM.
 *
 * What is worth asserting here is not that a dropdown renders. It is that the screen tells the truth
 * about **authority** and about **consequence**:
 *
 *  - a CSM who finds the control disabled can read who locked it and why, so a deliberate governance
 *    act is never indistinguishable from a bug;
 *  - the sentence under the dropdown describes the *pending* choice against the live Inactive
 *    definition, because that is the only moment it can still change the operator's mind;
 *  - the ticket queue badges work auto-dispatch is holding back **without** blocking a manual
 *    assignment — the threshold gates the engine, not the operator.
 */
const OPTIONS = [4, 8, 12, 24, 48, 72, 120, 168];

const view = (over: Partial<Record<string, unknown>> = {}) => ({
  hours: 24,
  options: OPTIONS,
  defaultHours: 24,
  lock: { locked: false, lockedAt: null, lockedBy: null, lockedByRole: null, lockReason: null },
  writeRoles: ['OPERATIONS_HEAD', 'CENTRAL_SERVICE_MANAGER'],
  inactivityThresholdHours: 24,
  canEdit: true,
  canLock: true,
  updatedAt: '2026-08-13T06:00:00.000Z',
  history: [],
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  sessionStorage.clear();
});

describe('#238 — SE assignment threshold (settings)', () => {
  it('offers the SLA-boundary ladder and marks the shipped default', async () => {
    fetchMock.mockImplementation(async () => json(view()));
    render(<AssignmentThresholdSection />);

    const select = (await screen.findByLabelText('SE assignment threshold')) as HTMLSelectElement;
    expect([...select.options].map((o) => Number(o.value))).toEqual(OPTIONS);
    expect(within(select).getByText(/24 h\+.*default/)).toBeInTheDocument();
  });

  it('spells out the consequence of the PENDING choice against the live Inactive definition', async () => {
    fetchMock.mockImplementation(async () => json(view()));
    render(<AssignmentThresholdSection />);

    // At the default the two agree, and the copy says so.
    expect(await screen.findByTestId('threshold-effect')).toHaveTextContent(/same point it is counted Inactive/);

    // Raising it describes a grace window — before anything is saved.
    await userEvent.selectOptions(screen.getByLabelText('SE assignment threshold'), '48');
    expect(screen.getByTestId('threshold-effect')).toHaveTextContent(/24 h grace window/);
    expect(screen.getByTestId('threshold-effect')).toHaveTextContent(/Fleet Uptime is unaffected/);

    // Lowering it warns about more tickets on devices the dashboards still call healthy.
    await userEvent.selectOptions(screen.getByLabelText('SE assignment threshold'), '12');
    expect(screen.getByTestId('threshold-effect')).toHaveTextContent(/before a device is counted Inactive/);
  });

  it('saves the chosen threshold with its reason', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toEqual({ hours: 48, reason: 'Monsoon' });
        return json(view({ hours: 48 }));
      }
      return json(view());
    });
    render(<AssignmentThresholdSection />);

    await userEvent.selectOptions(await screen.findByLabelText('SE assignment threshold'), '48');
    await userEvent.type(screen.getByLabelText('Reason for the threshold change'), 'Monsoon');
    await userEvent.click(screen.getByTestId('threshold-save'));

    await waitFor(() => expect(screen.getByTestId('threshold-saved')).toBeInTheDocument());
    expect(screen.getByTestId('threshold-current')).toHaveTextContent('48 h+');
  });

  it('tells a locked-out CSM who locked it and why, rather than silently disabling the control', async () => {
    fetchMock.mockImplementation(async () =>
      json(
        view({
          canEdit: false,
          canLock: false,
          lock: {
            locked: true,
            lockedAt: '2026-08-12T09:00:00.000Z',
            lockedBy: 'u-1',
            lockedByRole: 'OPERATIONS_HEAD',
            lockReason: 'Holding at 24h until the Q3 SLA review',
          },
        }),
      ),
    );
    render(<AssignmentThresholdSection />);

    const banner = await screen.findByTestId('threshold-authority');
    expect(banner).toHaveTextContent('Locked by Operations Head');
    expect(banner).toHaveTextContent('Holding at 24h until the Q3 SLA review');
    expect(screen.getByLabelText('SE assignment threshold')).toBeDisabled();
    // A locked-out CSM sees no lock control at all — it is not theirs to press.
    expect(screen.queryByTestId('threshold-unlock')).not.toBeInTheDocument();
  });

  it('shows the Operations Head a lock control and a revert target for each past value', async () => {
    fetchMock.mockImplementation(async () =>
      json(
        view({
          hours: 120,
          history: [
            {
              id: '9',
              previousHours: 48,
              newHours: 120,
              changeType: 'SET',
              actorId: 'u-2',
              actorRole: 'CENTRAL_SERVICE_MANAGER',
              reason: 'trial went further',
              revertedFromId: null,
              createdAt: '2026-08-13T05:00:00.000Z',
            },
            {
              id: '8',
              previousHours: 24,
              newHours: 48,
              changeType: 'SET',
              actorId: 'u-2',
              actorRole: 'CENTRAL_SERVICE_MANAGER',
              reason: 'trial',
              revertedFromId: null,
              createdAt: '2026-08-13T04:00:00.000Z',
            },
          ],
        }),
      ),
    );
    render(<AssignmentThresholdSection />);

    expect(await screen.findByTestId('threshold-lock')).toBeInTheDocument();
    // The value currently in force is not offered as a revert target; the superseded one is.
    expect(screen.queryByTestId('threshold-revert-9')).not.toBeInTheDocument();
    expect(screen.getByTestId('threshold-revert-8')).toHaveTextContent('Revert to 48 h');
  });
});

describe('#238 — the queue badges held work without blocking manual assignment', () => {
  const ticket = (over: Partial<TicketRow> = {}): TicketRow =>
    ({
      ticketId: 't-1',
      workType: 'TROUBLESHOOT',
      status: 'OPEN',
      deviceId: 'd-1',
      plantId: '1',
      companyId: '1',
      companyTier: 'GOLD',
      assignmentState: 'UNASSIGNED',
      slaBucket: 'RISK',
      latestGpsDatetime: null,
      inactivityHours: 18,
      repeatFailure: false,
      failureCycleState: 'OPEN',
      createdAt: '2026-08-13T00:00:00.000Z',
      ...over,
    }) as TicketRow;

  it('badges an unassigned ticket below the threshold with how far off it is', () => {
    render(<InlineBadges ticket={ticket()} assignmentThresholdHours={48} />);
    expect(screen.getByTestId('badge-BELOW_ASSIGNMENT_THRESHOLD')).toHaveTextContent('HELD · 18/48h');
  });

  it('does not badge a ticket that is already at or past the threshold', () => {
    render(<InlineBadges ticket={ticket({ inactivityHours: 60 })} assignmentThresholdHours={48} />);
    expect(screen.queryByTestId('badge-BELOW_ASSIGNMENT_THRESHOLD')).not.toBeInTheDocument();
  });

  it('does not badge an already-assigned ticket — the gate only ever applied to dispatch', () => {
    render(
      <InlineBadges ticket={ticket({ assignmentState: 'FORMALLY_ASSIGNED' })} assignmentThresholdHours={48} />,
    );
    expect(screen.queryByTestId('badge-BELOW_ASSIGNMENT_THRESHOLD')).not.toBeInTheDocument();
  });

  it('renders no badge at all when the threshold could not be read — a guessed "held" flag is worse than none', () => {
    render(<InlineBadges ticket={ticket()} assignmentThresholdHours={null} />);
    expect(screen.queryByTestId('badge-BELOW_ASSIGNMENT_THRESHOLD')).not.toBeInTheDocument();
  });
});

describe('#238 — navigation', () => {
  const links = (role: string) =>
    buildNav(role)
      .flatMap((g) => g.items)
      .map((i) => i.to);

  it('gives the CSM a route to the setting they co-own', () => {
    expect(links('CENTRAL_SERVICE_MANAGER')).toContain('/assignment-threshold');
  });

  it('gives the Operations Head the same route', () => {
    expect(links('OPERATIONS_HEAD')).toContain('/assignment-threshold');
  });

  it('withholds it from the ZM, who is the graded party', () => {
    expect(links('ZONAL_MANAGER')).not.toContain('/assignment-threshold');
    expect(links('SERVICE_ENGINEER')).not.toContain('/assignment-threshold');
  });
});
