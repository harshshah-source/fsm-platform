import type { SessionView } from '@fsm/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionRequiredCard } from '../src/api/dashboard';
import type { DispatchChangesTodayView, DispatchTodayView } from '../src/api/dispatchToday';
import { AuthProvider } from '../src/auth/AuthProvider';
import TodaysDispatchPage from '../src/pages/dispatch/TodaysDispatchPage';

/**
 * **Scheduler Console — Phase 3: the attention band and the honest counters.**
 *
 * Phase 3 answers *"of everything on this screen, what should I do first?"* — and the reason it is a
 * phase of its own rather than a panel is that getting it wrong is a correctness bug, not a layout
 * one. `action-required` was global for a CSM/OH; rendered beside a one-zone deck it would put a
 * national number under a zone's heading. B5 fixes that, and 3.2 must not ship before it.
 *
 * The other three are about the difference between *zero* and *not counted*, in three places: a funnel
 * population a run never recorded, an attention card whose source is not wired, and an actor id that
 * resolves to no user.
 */

vi.mock('../src/api/dispatchToday', async () => {
  const actual = await vi.importActual('../src/api/dispatchToday');
  return { ...actual, apiDispatchToday: vi.fn(), apiDispatchChangesToday: vi.fn() };
});
vi.mock('../src/api/dispatch-runs', async () => {
  const actual = await vi.importActual('../src/api/dispatch-runs');
  return { ...actual, apiDispatchRunDecisions: vi.fn(), apiDispatchTicketTrace: vi.fn() };
});
vi.mock('../src/api/dashboard', async () => {
  const actual = await vi.importActual('../src/api/dashboard');
  return { ...actual, apiActionRequired: vi.fn() };
});
vi.mock('../src/api/dispatchSchedule', async () => {
  const actual = await vi.importActual('../src/api/dispatchSchedule');
  return { ...actual, getDispatchInFlight: vi.fn(), getDispatchSchedule: vi.fn() };
});
vi.mock('../src/api/candidates', async () => {
  const actual = await vi.importActual('../src/api/candidates');
  return { ...actual, apiCandidates: vi.fn() };
});
vi.mock('../src/api/tickets', async () => {
  const actual = await vi.importActual('../src/api/tickets');
  return { ...actual, apiTicketDetail: vi.fn(), apiTicketAttempts: vi.fn() };
});
vi.mock('../src/api/org', async () => {
  const actual = await vi.importActual('../src/api/org');
  return { ...actual, listZones: vi.fn() };
});

const { apiDispatchToday, apiDispatchChangesToday } = await import('../src/api/dispatchToday');
const { apiActionRequired } = await import('../src/api/dashboard');
const { getDispatchInFlight, getDispatchSchedule } = await import('../src/api/dispatchSchedule');
const { apiCandidates } = await import('../src/api/candidates');
const { apiTicketDetail, apiTicketAttempts } = await import('../src/api/tickets');
const { listZones } = await import('../src/api/org');

const ZM: SessionView = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 7, acted_as_role: null };
const CSM: SessionView = { user_id: 'csm1', role: 'CENTRAL_SERVICE_MANAGER', zone_id: null, acted_as_role: null };

const situation = (over: Partial<DispatchTodayView['situation']> = {}): DispatchTodayView['situation'] => ({
  placed: 1,
  unassignable: 0,
  held: 0,
  criticalNeedsYou: 0,
  overCapacity: 0,
  changesToday: 0,
  componentBlockedWithheld: null,
  bucketlessDropped: null,
  ...over,
});

const view = (over: Partial<DispatchTodayView> = {}): DispatchTodayView => ({
  operatingDay: '2026-08-28',
  chronicThreshold: 3,
  agingThresholdHours: 4,
  zone: { zoneId: '7', name: 'North Zone' },
  run: { runId: '42', status: 'SUCCESS', trigger: 'CRON', startedAt: '2026-08-28T05:00:00Z', finishedAt: null },
  recovery: null,
  engineers: [
    {
      seId: 'se-1',
      name: 'Ramesh K.',
      coverageType: 'DEDICATED',
      committed: 1,
      dailyCapacity: 8,
      overCapacity: false,
      availability: 'AVAILABLE',
      scheduleId: '9',
      scheduleStatus: 'ACTIVE',
      stops: [],
    },
  ],
  situation: situation(),
  rails: { unassignable: [], held: [], policyWithheld: { count: 0, itemised: false } },
  escalations: [],
  ...over,
});

const changes = (over: Partial<DispatchChangesTodayView> = {}): DispatchChangesTodayView => ({
  operatingDay: '2026-08-28',
  zoneId: '7',
  counts: { adds: 0, removes: 0, swaps: 0, total: 0 },
  changes: [],
  ...over,
});

const card = (
  key: string,
  label: string,
  urgency: number,
  count: number,
  available: boolean,
): ActionRequiredCard => ({ key, label, urgency, count, available, source: 'test' });

const CARDS: ActionRequiredCard[] = [
  card('unreviewed_batches', 'Auto-dispatched batches today', 1, 0, false),
  card('vehicle_unavailability', 'Vehicle Unavailability & readiness conflicts', 2, 3, true),
  card('failed_verification', 'Failed Verification items', 4, 5, true),
  card('waiting_component_overdue', 'WAITING_COMPONENT over 7 days', 6, 0, true),
  card('recovery_stalled', 'Recovery Tickets stalled 14+ days', 9, 2, true),
];

const renderAt = (entry: string, session: SessionView = ZM) =>
  render(
    <AuthProvider initialSession={session}>
      <MemoryRouter initialEntries={[entry]}>
        <TodaysDispatchPage />
      </MemoryRouter>
    </AuthProvider>,
  );

beforeEach(() => {
  // The Work Pool rail is collapsed by default since 2026-09-01 (the board is the canvas). These
  // assertions are about what the rail *contains*, not about its default width, so they start from
  // the operator preference that opens it; the default and the toggle are covered explicitly in
  // `scheduler-console-composition.test.tsx`.
  localStorage.setItem('fsm.console.workRailOpen', '1');
  vi.mocked(apiDispatchToday).mockResolvedValue(view());
  vi.mocked(apiDispatchChangesToday).mockResolvedValue(changes());
  vi.mocked(apiActionRequired).mockResolvedValue(CARDS);
  vi.mocked(getDispatchInFlight).mockResolvedValue([]);
  vi.mocked(getDispatchSchedule).mockRejectedValue(new Error('forbidden'));
  vi.mocked(apiCandidates).mockResolvedValue({ date: '2026-08-28', plants: [] });
  vi.mocked(apiTicketDetail).mockResolvedValue({ lifecycle: [] } as never);
  vi.mocked(apiTicketAttempts).mockResolvedValue({
    ticketId: 't',
    threshold: 3,
    countableAttempts: 0,
    hasSubmission: false,
    isSpecial: false,
    attempts: [],
  });
  vi.mocked(listZones).mockResolvedValue([{ zoneId: 7, name: 'North Zone' }] as never);
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Phase 3.1/3.2 — the attention band, co-scoped with the deck', () => {
  /**
   * The correctness rule B5 exists for. Without `zoneId`, a CSM reads national counts under "North
   * Zone" and acts on them — two panes on one screen disagreeing about how much trouble a zone is in.
   */
  it('asks for the zone the deck is showing, never the global counts', async () => {
    renderAt('/dispatch/today?zoneId=7', CSM);
    await waitFor(() => expect(apiActionRequired).toHaveBeenCalledWith('7'));
  });

  it('ranks what needs a manager by urgency and gives every item one action', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today');

    // The band lives in the right-rail slot now, behind the top-bar strip (correction §11) — same
    // rules, same rows, one click further in and beside the deck it is co-scoped with.
    await user.click(await screen.findByTestId('attention-strip'));
    const band = await screen.findByTestId('console-attention');
    const rows = within(band).getAllByTestId(/^attention-(?!stubs)/);
    // Only the cards with work, in urgency order: vehicle_unavailability (2) then
    // failed_verification (4) then recovery_stalled (9). The zero-count live card is not a queue item.
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'attention-vehicle_unavailability',
      'attention-failed_verification',
      'attention-recovery_stalled',
    ]);
    // A count with no verb is a worry, not a queue.
    expect(within(rows[0]).getByRole('link')).toHaveAttribute('href', '/readiness/vehicle-unavailability');
    expect(within(rows[1]).getByRole('link')).toHaveAttribute('href', '/verification');
  });

  /**
   * `available: false` means "no source is wired for this yet". Rendering it as `0` would report the
   * absence of a counter as the absence of work — the single most misleading thing this band could do.
   */
  it('reports an unwired card as not counted, never as zero', async () => {
    const user = userEvent.setup();
    renderAt('/dispatch/today');

    await user.click(await screen.findByTestId('attention-strip'));
    const band = await screen.findByTestId('console-attention');
    await user.click(within(band).getByTestId('attention-stubs'));

    const stub = within(band).getByText(/Auto-dispatched batches today/).closest('li')!;
    // The badge, not the summary — the summary line ("1 category is not counted yet") says the same
    // words and would make this assertion pass even if the row itself rendered a bare 0.
    expect(within(stub).getByText(/^not counted$/i)).toBeInTheDocument();
    expect(within(stub).queryByText('0')).not.toBeInTheDocument();
    // A stub is never listed among the things that need doing.
    expect(within(band).queryByTestId('attention-unreviewed_batches')).not.toBeInTheDocument();
  });

  it('says the zone it is counting, and says so when nothing is waiting', async () => {
    const user = userEvent.setup();
    vi.mocked(apiActionRequired).mockResolvedValue([
      card('recovery_stalled', 'Recovery Tickets stalled 14+ days', 9, 0, true),
    ]);
    renderAt('/dispatch/today');

    await user.click(await screen.findByTestId('attention-strip'));
    const band = await screen.findByTestId('console-attention');
    expect(band).toHaveTextContent('North Zone');
    expect(within(band).getByTestId('attention-clear')).toHaveTextContent(/Nothing in North Zone/i);
  });

  /** Secondary content: it must not take the operating day down with it. */
  it('survives its own failure without touching the board', async () => {
    vi.mocked(apiActionRequired).mockRejectedValue(new Error('boom'));
    renderAt('/dispatch/today');

    expect(await screen.findByTestId('lane-se-1')).toBeInTheDocument();
    // The strip says the queue is unavailable instead of rendering a broken door; the board stands.
    expect(await screen.findByText(/attention queue unavailable/i)).toBeInTheDocument();
  });
});

describe('Phase 3.3 — B1: the funnel stops implying it is exhaustive', () => {
  it('renders a recorded population as its number', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({ situation: situation({ componentBlockedWithheld: 4, bucketlessDropped: 2 }) }),
    );
    renderAt('/dispatch/today');

    await screen.findByTestId('lane-se-1');
    expect(screen.getByText('Component-blocked')).toBeInTheDocument();
    expect(screen.getByText('No SLA bucket')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  /**
   * The rule this counter exists to respect. A run that predates #177 recorded nothing, and "0
   * component-blocked tickets" is a different claim from "this run did not count them".
   */
  it('renders an unrecorded population as unrecorded, never as zero', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({ situation: situation({ componentBlockedWithheld: null, bucketlessDropped: null }) }),
    );
    renderAt('/dispatch/today');

    await screen.findByTestId('lane-se-1');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/not recorded by this run/i).length).toBe(2);
  });
});

describe('Phase 3.3 — B2: when the next run fires', () => {
  it('shows the next scheduled run to a Zonal Manager', async () => {
    vi.mocked(getDispatchSchedule).mockResolvedValue({
      cron: '0 5 * * *',
      timeZone: 'Asia/Kolkata',
      nextFireAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    renderAt('/dispatch/today');

    expect(await screen.findByTestId('console-next-run')).toBeInTheDocument();
  });

  /** A hard-coded "05:00" would be a fabricated answer to the one question this pill exists for —
   *  the hour is configurable and can be moved without a restart. */
  it('renders nothing rather than guessing when the schedule cannot be read', async () => {
    vi.mocked(getDispatchSchedule).mockRejectedValue(new Error('403'));
    renderAt('/dispatch/today');

    await screen.findByTestId('lane-se-1');
    expect(screen.queryByTestId('console-next-run')).not.toBeInTheDocument();
  });
});

/**
 * **3.4 — the chronic-device signal**, under the operator's D6 (naming) and D8 (framing) rulings of
 * 2026-08-28: it is called *chronic device*, and it is a **replace-or-investigate** queue rather than a
 * go-sooner one, because under the current engine no visit gets faster for these devices.
 */
describe('Phase 3.4 — chronic device', () => {
  const chip = (id: string, failureCycles: number | null) => ({
    ticketId: id,
    sortOrder: 1,
    slaBucket: 'WARNING',
    companyTier: 'GOLD',
    addSource: 'AUTO_DISPATCH',
    addedBy: null,
    addReason: null,
    coverageTypeAtAssign: 'DEDICATED',
    systemPlaced: true,
    returnDueToday: false,
    failureCycles,
    deviceId: '869645080787056',
    vehicleNo: 'MH-12-AB-3456',
    companyName: 'Northbound Cement',
    transporterName: 'Sharma Logistics',
    inactivityHours: 18,
    assignedAt: '2026-08-28T05:30:00Z',
    troubleshootingStarted: false,
    actionStatus: 'NOT_STARTED' as const,
  });

  const withChips = (cycles: (number | null)[]) =>
    view({
      engineers: [
        {
          ...view().engineers[0],
          stops: [
            {
              batchId: 'b1',
              stopSequence: 1,
              plantId: '4',
              plantName: 'Acme Cement',
              status: 'AUTO_ASSIGNED',
              runId: '42',
              tickets: cycles.map((c, i) => chip(`ticket-${i}`, c)),
            },
          ],
        },
      ],
    });

  it('marks a chronic device on the board with how chronic it is', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(withChips([4]));
    renderAt('/dispatch/today');

    const marker = await screen.findByTestId('chronic-ticket-0');
    expect(marker).toHaveTextContent('CHR ×4');
  });

  /**
   * #290 fixed a real collision in the border grammar — over capacity had been drawn crimson (reserved
   * for critical) and tier-crossing amber (reserved for over capacity). The chronic marker must not
   * re-create that on a fourth meaning, so it is an inline token in the `RET` idiom, never a border.
   */
  it('does not spend a border colour on the marker', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(withChips([4]));
    renderAt('/dispatch/today');

    const marker = await screen.findByTestId('chronic-ticket-0');
    expect(marker.className).not.toMatch(/border/);
    // And it survives grayscale, because it carries a word and a number rather than a hue.
    expect(marker.textContent).toMatch(/CHR/);
  });

  it('leaves a device below the threshold unmarked, and never marks an unresolved one', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue(withChips([2, null]));
    renderAt('/dispatch/today');

    await screen.findByTestId('lane-se-1');
    expect(screen.queryByTestId('chronic-ticket-0')).not.toBeInTheDocument();
    // Null is "we could not tell which device this is", which is not a claim about reliability.
    expect(screen.queryByTestId('chronic-ticket-1')).not.toBeInTheDocument();
  });

  /** #244's precedent: the threshold comes from the payload, so a client can never disagree with the
   *  server about what the verdict means. */
  it('honours the threshold the payload publishes rather than a hard-coded 3', async () => {
    vi.mocked(apiDispatchToday).mockResolvedValue({ ...withChips([4]), chronicThreshold: 5 });
    renderAt('/dispatch/today');

    await screen.findByTestId('lane-se-1');
    expect(screen.queryByTestId('chronic-ticket-0')).not.toBeInTheDocument();
  });

  it('filters the work pool to chronic devices, and frames it as a replacement decision', async () => {
    const user = userEvent.setup();
    vi.mocked(apiDispatchToday).mockResolvedValue(
      view({
        rails: {
          unassignable: [
            { ticketId: 'chronic-1', deviceId: 'DEV-C', plantId: '5', plantName: 'Beta', poolEmptyReason: 'NO_COVERAGE', failureCycles: 4 },
            { ticketId: 'ordinary-1', deviceId: 'DEV-O', plantId: '5', plantName: 'Beta', poolEmptyReason: 'NO_COVERAGE', failureCycles: 1 },
          ],
          held: [],
          policyWithheld: { count: 0, itemised: false },
        },
      }),
    );
    renderAt('/dispatch/today');

    const rail = await screen.findByTestId('console-work-rail');
    expect(within(rail).getByTestId('pool-filter-chronic')).toHaveTextContent('1');
    expect(within(rail).getByText('DEV-O')).toBeInTheDocument();

    await user.click(within(rail).getByTestId('pool-filter-chronic'));
    expect(within(rail).getByText('DEV-C')).toBeInTheDocument();
    expect(within(rail).queryByText('DEV-O')).not.toBeInTheDocument();

    // D8 — no promise of a faster visit, because the engine cannot keep one.
    const framing = within(rail).getByTestId('chronic-framing');
    expect(framing).toHaveTextContent(/replace/i);
    expect(framing).not.toHaveTextContent(/sooner|urgent|priorit/i);
  });

  /** A chip that can never light is worse than no chip — Phase 0.3's whole lesson. */
  it('hides the filter entirely when no device in the zone is chronic', async () => {
    renderAt('/dispatch/today');

    const rail = await screen.findByTestId('console-work-rail');
    expect(within(rail).queryByTestId('pool-filter-chronic')).not.toBeInTheDocument();
  });
});

describe('Phase 3.3 — B7: the change ledger names the actor', () => {
  it('says who made the change instead of publishing a UUID', async () => {
    const user = userEvent.setup();
    vi.mocked(apiDispatchChangesToday).mockResolvedValue(
      changes({
        counts: { adds: 1, removes: 0, swaps: 0, total: 1 },
        changes: [
          {
            kind: 'ADD',
            ticketId: '11111111-2222-3333-4444-555555555555',
            actorId: '77777777-8888-9999-aaaa-bbbbbbbbbbbb',
            actorName: 'Ravi Menon',
            at: '2026-08-28T09:14:00Z',
            reason: 'customer escalation',
            toSeId: 'se-1',
            fromSeId: null,
            via: 'MANUAL_ASSIGN',
          },
        ],
      }),
    );
    renderAt('/dispatch/today');

    await user.click(await screen.findByTestId('pool-tab-changes'));
    const rail = screen.getByTestId('console-work-rail');
    expect(within(rail).getByText(/Ravi Menon/)).toBeInTheDocument();
    expect(within(rail).queryByText(/77777777-8888/)).not.toBeInTheDocument();
  });

  /** Null is a real case — a system actor, or a deleted user. Fall back to the id, never a name. */
  it('falls back to the id when the actor resolves to no user', async () => {
    const user = userEvent.setup();
    vi.mocked(apiDispatchChangesToday).mockResolvedValue(
      changes({
        counts: { adds: 1, removes: 0, swaps: 0, total: 1 },
        changes: [
          {
            kind: 'ADD',
            ticketId: '11111111-2222-3333-4444-555555555555',
            actorId: '77777777-8888-9999-aaaa-bbbbbbbbbbbb',
            actorName: null,
            at: '2026-08-28T09:14:00Z',
            reason: null,
            toSeId: 'se-1',
            fromSeId: null,
            via: 'MANUAL_ASSIGN',
          },
        ],
      }),
    );
    renderAt('/dispatch/today');

    await user.click(await screen.findByTestId('pool-tab-changes'));
    expect(within(screen.getByTestId('console-work-rail')).getByText(/77777777/)).toBeInTheDocument();
  });
});
