import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import type { MeTicketRow, MeTicketsView } from '@fsm/shared';
import { TicketsScreen } from './TicketsScreen';
import { apiGetMyTickets } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { getConnectivityState } from '../../api/connectivity';
import { __resetPlanCuesForTests } from '../../tickets/dayPlanCues';

jest.mock('../../api/client', () => ({ apiGetMyTickets: jest.fn() }));
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));
jest.mock('../../api/connectivity', () => ({ getConnectivityState: jest.fn() }));
// Unit-test the navigation wiring only — TicketDetailScreen's own behavior is covered by its
// own test file.
jest.mock('../../tickets/detail/TicketDetailScreen', () => {
  const { Text } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    TicketDetailScreen: ({ ticketId, onBack }: { ticketId: string; onBack: () => void }) => (
      <>
        <Text testID="mock-detail-ticket-id">{ticketId}</Text>
        <Text testID="mock-detail-back" onPress={onBack}>
          Back
        </Text>
      </>
    ),
  };
});

const mockApiGetMyTickets = jest.mocked(apiGetMyTickets);
const mockGetAccessToken = jest.mocked(getAccessToken);
const mockGetConnectivityState = jest.mocked(getConnectivityState);

function row(overrides: Partial<MeTicketRow>): MeTicketRow {
  return {
    ticketId: 't-1',
    ticketNo: 306,
    ticketNoDisplay: 'TCK-00306',
    assigned: false,
    workState: 'VISIT_NOW',
    workType: 'TROUBLESHOOT',
    status: 'OPEN',
    plantId: 'p-1',
    plantName: 'JSW Cement - Surat Plant',
    companyName: 'JSW Cement',
    companyTier: 'GOLD',
    slaBucket: 'HIGH_CRITICAL',
    deviceId: 'GPS401',
    vehicleId: null,
    vehicleNo: 'GJ05 LM 2201',
    activeSoftState: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    lastStateChangedAt: new Date('2026-08-01T00:00:00Z'),
    removedFromPlanAt: null,
    deferredToDate: null,
    topHint: { code: 'NO_MAIN_POWER', severity: 8, label: 'No main power — check fuse' },
    vehicleUnavailability: null,
    ...overrides,
  };
}

describe('TicketsScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
    __resetPlanCuesForTests();
  });

  it('groups VISIT_NOW rows under Visit Now and everything else under Other Tickets', async () => {
    mockGetConnectivityState.mockResolvedValue('online');
    mockGetAccessToken.mockResolvedValue('token');
    const view: MeTicketsView = {
      items: [
        row({ ticketId: 'urgent-1', workState: 'VISIT_NOW', vehicleNo: 'GJ05 LM 2201' }),
        row({ ticketId: 'plan-1', workState: 'PLAN', vehicleNo: 'MH14 CD 8901' }),
        row({ ticketId: 'verify-1', workState: 'VERIFY', vehicleNo: 'MH01 XY 9090' }),
      ],
      cursor: null,
      total: 3,
    };
    mockApiGetMyTickets.mockResolvedValue(view);

    render(<TicketsScreen />);

    await waitFor(() => expect(screen.getByText('GJ05 LM 2201')).toBeTruthy());
    expect(screen.getByTestId('tickets-visit-now-section')).toBeTruthy();
    expect(screen.getByTestId('tickets-other-section')).toBeTruthy();
    expect(screen.getByText('MH14 CD 8901')).toBeTruthy();
    expect(screen.getByText('MH01 XY 9090')).toBeTruthy();
  });

  it('shows a distinct empty state for an empty Visit Now section', async () => {
    mockGetConnectivityState.mockResolvedValue('online');
    mockGetAccessToken.mockResolvedValue('token');
    mockApiGetMyTickets.mockResolvedValue({
      items: [row({ ticketId: 'plan-1', workState: 'PLAN' })],
      cursor: null,
      total: 1,
    });

    render(<TicketsScreen />);

    await waitFor(() => expect(screen.getByTestId('tickets-visit-now-empty')).toBeTruthy());
    expect(screen.queryByTestId('tickets-other-empty')).toBeNull();
  });

  it('shows a distinct empty state for an empty Other Tickets section', async () => {
    mockGetConnectivityState.mockResolvedValue('online');
    mockGetAccessToken.mockResolvedValue('token');
    mockApiGetMyTickets.mockResolvedValue({
      items: [row({ ticketId: 'urgent-1', workState: 'VISIT_NOW' })],
      cursor: null,
      total: 1,
    });

    render(<TicketsScreen />);

    await waitFor(() => expect(screen.getByTestId('tickets-other-empty')).toBeTruthy());
    expect(screen.queryByTestId('tickets-visit-now-empty')).toBeNull();
  });

  it('falls back to the ticket number label when a row has no vehicle attached', async () => {
    mockGetConnectivityState.mockResolvedValue('online');
    mockGetAccessToken.mockResolvedValue('token');
    mockApiGetMyTickets.mockResolvedValue({
      items: [row({ ticketId: 'no-vehicle', vehicleNo: null, ticketNoDisplay: 'TCK-00999' })],
      cursor: null,
      total: 1,
    });

    render(<TicketsScreen />);

    await waitFor(() => expect(screen.getByText('TCK-00999')).toBeTruthy());
  });

  it('shows an offline banner and renders nothing stale when there is no cache yet', async () => {
    mockGetConnectivityState.mockResolvedValue('offline');

    render(<TicketsScreen />);

    await waitFor(() => expect(screen.getByTestId('tickets-offline-banner')).toBeTruthy());
    expect(mockApiGetMyTickets).not.toHaveBeenCalled();
  });

  describe('filter chips', () => {
    const items = [
      row({ ticketId: 'urgent-1', workState: 'VISIT_NOW', vehicleNo: 'V-VISIT' }),
      row({ ticketId: 'plan-1', workState: 'PLAN', vehicleNo: 'V-PLAN' }),
      row({ ticketId: 'work-1', workState: 'IN_WORK', vehicleNo: 'V-WORK' }),
      row({ ticketId: 'verify-1', workState: 'VERIFY', vehicleNo: 'V-VERIFY' }),
    ];

    async function renderReady() {
      mockGetConnectivityState.mockResolvedValue('online');
      mockGetAccessToken.mockResolvedValue('token');
      mockApiGetMyTickets.mockResolvedValue({ items, cursor: null, total: items.length });
      render(<TicketsScreen />);
      await waitFor(() => expect(screen.getByText('V-VISIT')).toBeTruthy());
    }

    it('shows every row under the default "All" chip', async () => {
      await renderReady();

      expect(screen.getByText('V-VISIT')).toBeTruthy();
      expect(screen.getByText('V-PLAN')).toBeTruthy();
      expect(screen.getByText('V-WORK')).toBeTruthy();
      expect(screen.getByText('V-VERIFY')).toBeTruthy();
    });

    it('narrows to only Plan rows when the Plan chip is pressed', async () => {
      await renderReady();

      fireEvent.press(screen.getByTestId('ticket-filter-PLAN'));

      expect(screen.getByText('V-PLAN')).toBeTruthy();
      expect(screen.queryByText('V-VISIT')).toBeNull();
      expect(screen.queryByText('V-WORK')).toBeNull();
      expect(screen.queryByText('V-VERIFY')).toBeNull();
    });

    it('returns to showing every row when All is pressed again', async () => {
      await renderReady();

      fireEvent.press(screen.getByTestId('ticket-filter-VERIFY'));
      fireEvent.press(screen.getByTestId('ticket-filter-ALL'));

      expect(screen.getByText('V-VISIT')).toBeTruthy();
      expect(screen.getByText('V-PLAN')).toBeTruthy();
    });
  });

  describe('row tap navigation', () => {
    it('opens TicketDetailScreen for the tapped ticket, and returns to the list on back', async () => {
      mockGetConnectivityState.mockResolvedValue('online');
      mockGetAccessToken.mockResolvedValue('token');
      mockApiGetMyTickets.mockResolvedValue({
        items: [row({ ticketId: 'urgent-42', workState: 'VISIT_NOW', vehicleNo: 'V-TAP' })],
        cursor: null,
        total: 1,
      });
      render(<TicketsScreen />);
      await waitFor(() => expect(screen.getByText('V-TAP')).toBeTruthy());

      fireEvent.press(screen.getByText('V-TAP'));

      expect(screen.getByText('urgent-42')).toBeTruthy();
      expect(screen.queryByTestId('screen-tickets')).toBeNull();

      fireEvent.press(screen.getByTestId('mock-detail-back'));

      expect(screen.getByTestId('screen-tickets')).toBeTruthy();
      expect(screen.getByText('V-TAP')).toBeTruthy();
    });
  });

  describe('#66 — same-day update cues (client-side set-diff vs the cached prior fetch)', () => {
    it('no cache on first load → no Newly Added / Removed badges', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetConnectivityState.mockResolvedValue('online');
      mockApiGetMyTickets.mockResolvedValue({
        items: [row({ ticketId: 'a', assigned: true, vehicleNo: 'V-A' })],
        cursor: null,
        total: 1,
      });

      render(<TicketsScreen />);

      await waitFor(() => expect(screen.getByText('V-A')).toBeTruthy());
      expect(screen.queryByText('Newly Added')).toBeNull();
      expect(screen.queryByText('Removed')).toBeNull();
    });

    it('a ticket added since the cached fetch shows a Newly Added badge, sorted to the top', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetConnectivityState.mockResolvedValue('online');
      mockApiGetMyTickets.mockResolvedValue({
        items: [row({ ticketId: 'a', assigned: true, workState: 'PLAN', vehicleNo: 'V-A' })],
        cursor: null,
        total: 1,
      });
      const first = render(<TicketsScreen />);
      await waitFor(() => expect(first.getByText('V-A')).toBeTruthy());
      first.unmount();

      mockApiGetMyTickets.mockResolvedValue({
        items: [
          row({ ticketId: 'a', assigned: true, workState: 'PLAN', vehicleNo: 'V-A' }),
          // Non-critical bucket, deliberately: this test is about the GENERIC "Newly Added" label,
          // which the #268 rewrite of `badgeFor` now derives from the bucket (see the describe block
          // below) — a CRITICAL/HIGH_CRITICAL default here would silently test the other label instead.
          row({ ticketId: 'b', assigned: true, workState: 'PLAN', vehicleNo: 'V-B', slaBucket: 'WARNING' }),
        ],
        cursor: null,
        total: 2,
      });
      render(<TicketsScreen />);

      await waitFor(() => expect(screen.getByText('V-B')).toBeTruthy());
      expect(screen.getByText('Newly Added')).toBeTruthy();
    });

    it('a ticket removed since the cached fetch shows a one-session Removed label, reconstructed from the cached row', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetConnectivityState.mockResolvedValue('online');
      mockApiGetMyTickets.mockResolvedValue({
        items: [
          row({ ticketId: 'a', assigned: true, workState: 'PLAN', vehicleNo: 'V-A' }),
          row({ ticketId: 'b', assigned: true, workState: 'PLAN', vehicleNo: 'V-B' }),
        ],
        cursor: null,
        total: 2,
      });
      const first = render(<TicketsScreen />);
      await waitFor(() => expect(first.getByText('V-B')).toBeTruthy());
      first.unmount();

      mockApiGetMyTickets.mockResolvedValue({
        items: [row({ ticketId: 'a', assigned: true, workState: 'PLAN', vehicleNo: 'V-A' })],
        cursor: null,
        total: 1,
      });
      render(<TicketsScreen />);

      await waitFor(() => expect(screen.getByText('V-B')).toBeTruthy());
      expect(screen.getByText('Removed')).toBeTruthy();
    });
  });

  describe('#268 — CRITICAL INSERTION badge, derived from the ticket\'s own SLA bucket', () => {
    it('badges a newly-added CRITICAL/HIGH_CRITICAL ticket CRITICAL INSERTION instead of the generic Newly Added label', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetConnectivityState.mockResolvedValue('online');
      mockApiGetMyTickets.mockResolvedValue({
        items: [row({ ticketId: 'a', assigned: true, workState: 'PLAN', vehicleNo: 'V-A' })],
        cursor: null,
        total: 1,
      });
      const first = render(<TicketsScreen />);
      await waitFor(() => expect(first.getByText('V-A')).toBeTruthy());
      first.unmount();

      mockApiGetMyTickets.mockResolvedValue({
        items: [
          row({ ticketId: 'a', assigned: true, workState: 'PLAN', vehicleNo: 'V-A' }),
          // row()'s default slaBucket is HIGH_CRITICAL — the same bucket that made this ticket
          // eligible for the backend's direct-assign sweep in the first place (#268's TRIGGER_BUCKETS).
          row({ ticketId: 'b', assigned: true, workState: 'PLAN', vehicleNo: 'V-B' }),
        ],
        cursor: null,
        total: 3,
      });
      render(<TicketsScreen />);

      await waitFor(() => expect(screen.getByText('V-B')).toBeTruthy());
      expect(screen.getByText('CRITICAL INSERTION')).toBeTruthy();
      expect(screen.queryByText('Newly Added')).toBeNull();
    });

    it('does not badge CRITICAL INSERTION on first load, even for a CRITICAL/HIGH_CRITICAL ticket — nothing is "newly added" without a prior fetch to diff against', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetConnectivityState.mockResolvedValue('online');
      mockApiGetMyTickets.mockResolvedValue({
        items: [row({ ticketId: 'a', assigned: true, workState: 'PLAN', vehicleNo: 'V-A' })],
        cursor: null,
        total: 1,
      });

      render(<TicketsScreen />);

      await waitFor(() => expect(screen.getByText('V-A')).toBeTruthy());
      expect(screen.queryByText('CRITICAL INSERTION')).toBeNull();
    });
  });
});
