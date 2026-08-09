import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import type { DayPlanView, MeTicketRow, SessionView } from '@fsm/shared';
import { HomeScreen } from './HomeScreen';
import { apiGetDayPlan, apiGetMyTickets, apiGetNotifications, apiGetWorkHistory } from '../../api/client';
import { getConnectivityState } from '../../api/connectivity';
import { useAuth } from '../../auth/AuthProvider';
import { getAccessToken } from '../../auth/tokenStore';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return {
    ...actual,
    apiGetDayPlan: jest.fn(),
    apiGetMyTickets: jest.fn(),
    apiGetNotifications: jest.fn(),
    apiGetWorkHistory: jest.fn(),
  };
});
jest.mock('../../api/connectivity', () => ({ getConnectivityState: jest.fn() }));
jest.mock('../../auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));
jest.mock('../../notifications/NotificationsScreen', () => {
  const { Text } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    NotificationsScreen: ({ onBack }: { onBack: () => void }) => (
      <Text testID="mock-notifications-screen" onPress={onBack}>
        Notifications
      </Text>
    ),
  };
});

const mockGetDayPlan = jest.mocked(apiGetDayPlan);
const mockGetMyTickets = jest.mocked(apiGetMyTickets);
const mockGetNotifications = jest.mocked(apiGetNotifications);
const mockGetWorkHistory = jest.mocked(apiGetWorkHistory);
const mockGetConnectivity = jest.mocked(getConnectivityState);
const mockUseAuth = jest.mocked(useAuth);
const mockGetAccessToken = jest.mocked(getAccessToken);

const session: SessionView = {
  user_id: 'se-1',
  role: 'SERVICE_ENGINEER',
  zone_id: 3,
  acted_as_role: null,
  profile: {
    name: 'Rahul',
    phone: '9000000000',
    email: 'rahul@fsm.test',
    zoneName: 'WEST',
    coverageType: 'DEDICATED',
    homePlant: { plantId: 'p-1', name: 'Nuvoco - Mumbai Plant' },
    reportsTo: null,
  },
};

function row(overrides: Partial<MeTicketRow>): MeTicketRow {
  return {
    ticketId: 't-1',
    ticketNo: 1,
    ticketNoDisplay: 'TCK-00001',
    assigned: true,
    workState: 'PLAN',
    workType: 'TROUBLESHOOT',
    status: 'OPEN',
    plantId: 'p-1',
    plantName: 'Nuvoco - Mumbai Plant',
    companyName: 'Nuvoco',
    companyTier: 'GOLD',
    slaBucket: null,
    deviceId: 'd-1',
    vehicleId: null,
    vehicleNo: null,
    activeSoftState: null,
    createdAt: new Date('2026-08-04T00:00:00Z'),
    lastStateChangedAt: new Date('2026-08-04T00:00:00Z'),
    removedFromPlanAt: null,
    deferredToDate: null,
    topHint: null,
    ...overrides,
  };
}

const dayPlan: DayPlanView = {
  dispatched: true,
  scheduleId: 's-1',
  dateFrom: '2026-08-04',
  dateTo: '2026-08-04',
  stops: [
    {
      batchId: 'b-1',
      stopSequence: 1,
      plantId: 'p-1',
      plantName: 'Nuvoco - Mumbai Plant',
      deviceCount: 2,
      tickets: [
        { ticketId: 't-1', sortOrder: 1 },
        { ticketId: 't-2', sortOrder: 2 },
      ],
    },
  ],
};

function renderHome() {
  return render(
    <NavigationContainer>
      <HomeScreen />
    </NavigationContainer>,
  );
}

describe('HomeScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  beforeEach(() => {
    mockGetNotifications.mockResolvedValue({ items: [], unreadCount: 0 });
    mockGetWorkHistory.mockResolvedValue({ days: [] });
  });

  it('renders the SE name, home plant and zone in the header, plus the two status chips', async () => {
    mockUseAuth.mockReturnValue({
      session,
      loading: false,
      login: jest.fn<(email: string, password: string) => Promise<void>>(),
      logout: jest.fn<() => Promise<void>>(),
    });
    mockGetAccessToken.mockResolvedValue('token');
    mockGetConnectivity.mockResolvedValue('online');
    mockGetDayPlan.mockResolvedValue(dayPlan);
    mockGetMyTickets.mockResolvedValue({ items: [], cursor: null });

    renderHome();

    await waitFor(() => expect(screen.getByText('Rahul')).toBeTruthy());
    // One `plant · zone` line, as the reference image shows — not two separate labels.
    expect(screen.getByText('Nuvoco - Mumbai Plant · WEST')).toBeTruthy();
    expect(screen.getByTestId('home-online-chip')).toBeTruthy();
    expect(screen.getByTestId('home-last-sync-chip')).toBeTruthy();
    expect(screen.getByText('Network status')).toBeTruthy();
    expect(screen.getByText('Last sync')).toBeTruthy();
    // The product's own name, mirroring apps/admin's BrandLogo wordmark exactly.
    expect(screen.getByText('autoplant Systems')).toBeTruthy();
    expect(screen.getByText('Field Management System')).toBeTruthy();
    // Avatar initials from the SE's name.
    expect(screen.getByText('RA')).toBeTruthy();
  });

  it('renders KPI tiles derived from assigned tickets', async () => {
    mockUseAuth.mockReturnValue({
      session,
      loading: false,
      login: jest.fn<(email: string, password: string) => Promise<void>>(),
      logout: jest.fn<() => Promise<void>>(),
    });
    mockGetAccessToken.mockResolvedValue('token');
    mockGetConnectivity.mockResolvedValue('online');
    mockGetDayPlan.mockResolvedValue(dayPlan);
    mockGetMyTickets.mockResolvedValue({
      items: [row({ ticketId: 't-1', workState: 'IN_WORK' }), row({ ticketId: 't-2', status: 'CLOSED' })],
      cursor: null,
    });

    renderHome();

    await waitFor(() => expect(screen.getByTestId('home-kpi-started')).toBeTruthy());
    expect(screen.getByTestId('home-kpi-started').props.children).toBe(1);
    expect(screen.getByTestId('home-kpi-completed').props.children).toBe(1);
  });

  it('shows the pre-dispatch empty state when dispatched is false, with the exact PRD copy', async () => {
    mockUseAuth.mockReturnValue({
      session,
      loading: false,
      login: jest.fn<(email: string, password: string) => Promise<void>>(),
      logout: jest.fn<() => Promise<void>>(),
    });
    mockGetAccessToken.mockResolvedValue('token');
    mockGetConnectivity.mockResolvedValue('online');
    mockGetDayPlan.mockResolvedValue({ dispatched: false, scheduleId: null, dateFrom: null, dateTo: null, stops: [] });
    mockGetMyTickets.mockResolvedValue({ items: [], cursor: null });

    renderHome();

    await waitFor(() => expect(screen.getByText('Your plan is being prepared — check back shortly.')).toBeTruthy());
  });

  it('renders Next Visit and Plant Workload from the day plan stops', async () => {
    mockUseAuth.mockReturnValue({
      session,
      loading: false,
      login: jest.fn<(email: string, password: string) => Promise<void>>(),
      logout: jest.fn<() => Promise<void>>(),
    });
    mockGetAccessToken.mockResolvedValue('token');
    mockGetConnectivity.mockResolvedValue('online');
    mockGetDayPlan.mockResolvedValue(dayPlan);
    mockGetMyTickets.mockResolvedValue({
      items: [row({ ticketId: 't-1', status: 'CLOSED' }), row({ ticketId: 't-2', status: 'OPEN' })],
      cursor: null,
    });

    renderHome();

    await waitFor(() => expect(screen.getByTestId('next-visit-card')).toBeTruthy());
    expect(screen.getAllByText('Nuvoco - Mumbai Plant').length).toBeGreaterThan(0);
    expect(screen.getByTestId('plant-workload-p-1')).toBeTruthy();
    // One CLOSED of two tickets at the stop → the ring, the meter and the ratio all say the same thing.
    expect(screen.getByTestId('plant-workload-pct-p-1').props.children).toBe('50%');
    expect(screen.getByTestId('plant-workload-ratio-p-1').props.children).toBe('1/2');
    expect(screen.getByText('1 work')).toBeTruthy();
    expect(screen.getByText('1 pending')).toBeTruthy();
    // The section counts the plants it is showing.
    expect(screen.getByTestId('plant-workload-count')).toBeTruthy();
  });

  it('renders the Next Visit subline counts derived from the stop\'s tickets', async () => {
    mockUseAuth.mockReturnValue({
      session,
      loading: false,
      login: jest.fn<(email: string, password: string) => Promise<void>>(),
      logout: jest.fn<() => Promise<void>>(),
    });
    mockGetAccessToken.mockResolvedValue('token');
    mockGetConnectivity.mockResolvedValue('online');
    mockGetDayPlan.mockResolvedValue(dayPlan);
    mockGetMyTickets.mockResolvedValue({
      items: [
        // CRITICAL is urgent and this one is started; RISK is inactive but neither urgent nor started.
        row({ ticketId: 't-1', slaBucket: 'CRITICAL', workState: 'IN_WORK' }),
        row({ ticketId: 't-2', slaBucket: 'RISK' }),
      ],
      cursor: null,
    });

    renderHome();

    await waitFor(() => expect(screen.getByTestId('next-visit-stats')).toBeTruthy());
    expect(screen.getByTestId('next-visit-stats').props.children).toBe('2 inactive · 1 urgent · 1 in work');
  });

  describe('#175 — Assigned vs Completed chart', () => {
    const withHistory = () => {
      mockUseAuth.mockReturnValue({
        session,
        loading: false,
        login: jest.fn<(email: string, password: string) => Promise<void>>(),
        logout: jest.fn<() => Promise<void>>(),
      });
      mockGetAccessToken.mockResolvedValue('token');
      mockGetConnectivity.mockResolvedValue('online');
      mockGetDayPlan.mockResolvedValue(dayPlan);
      mockGetMyTickets.mockResolvedValue({ items: [], cursor: null });
    };

    it('renders one labelled bar per day from GET /api/me/work-history', async () => {
      withHistory();
      mockGetWorkHistory.mockResolvedValue({
        days: [
          { date: '2026-05-07', assigned: 6, completed: 4 },
          { date: '2026-05-08', assigned: 8, completed: 5 },
          // A day the SE had no schedule still gets a bar — the series is dense by contract.
          { date: '2026-05-09', assigned: 0, completed: 0 },
        ],
      });

      renderHome();

      await waitFor(() => expect(screen.getByTestId('work-history-chart')).toBeTruthy());
      expect(screen.getByText('Assigned vs Completed')).toBeTruthy();
      expect(screen.getByText('4/6')).toBeTruthy();
      expect(screen.getByText('5/8')).toBeTruthy();
      expect(screen.getByText('07 May')).toBeTruthy();
      // The zero day is scoped to its own bar — the Plant Workload card also renders a `0/0` ratio,
      // and a global text query would pass on the wrong element.
      const zeroDay = within(screen.getByTestId('work-history-bar-2026-05-09'));
      expect(zeroDay.getByText('0/0')).toBeTruthy();
      expect(zeroDay.getByText('09 May')).toBeTruthy();
    });

    it('still renders the rest of Home when the history read fails', async () => {
      withHistory();
      mockGetWorkHistory.mockRejectedValue(new Error('UNAUTHORIZED'));

      renderHome();

      // The chart is additive: a failed series must degrade to an empty chart, never blank the screen
      // or push it into the offline state, which would hide a day plan the SE can actually work.
      await waitFor(() => expect(screen.getByTestId('next-visit-card')).toBeTruthy());
      expect(screen.getByTestId('work-history-empty')).toBeTruthy();
      expect(screen.queryByTestId('home-offline-badge')).toBeNull();
    });
  });

  it('shows the Open Ticket Pool count from unassigned tickets', async () => {
    mockUseAuth.mockReturnValue({
      session,
      loading: false,
      login: jest.fn<(email: string, password: string) => Promise<void>>(),
      logout: jest.fn<() => Promise<void>>(),
    });
    mockGetAccessToken.mockResolvedValue('token');
    mockGetConnectivity.mockResolvedValue('online');
    mockGetDayPlan.mockResolvedValue(dayPlan);
    mockGetMyTickets.mockResolvedValue({
      items: [row({ ticketId: 't-1', assigned: true }), row({ ticketId: 't-2', assigned: false }), row({ ticketId: 't-3', assigned: false })],
      cursor: null,
    });

    renderHome();

    await waitFor(() => expect(screen.getByTestId('open-ticket-pool-button')).toBeTruthy());
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('shows an offline indicator when connectivity is offline', async () => {
    mockUseAuth.mockReturnValue({
      session,
      loading: false,
      login: jest.fn<(email: string, password: string) => Promise<void>>(),
      logout: jest.fn<() => Promise<void>>(),
    });
    mockGetAccessToken.mockResolvedValue('token');
    mockGetConnectivity.mockResolvedValue('offline');
    mockGetDayPlan.mockResolvedValue(dayPlan);
    mockGetMyTickets.mockResolvedValue({ items: [], cursor: null });

    renderHome();

    await waitFor(() => expect(screen.getByTestId('home-offline-badge')).toBeTruthy());
  });

  describe('#85 — Notifications entry point', () => {
    it('opens NotificationsScreen when the header button is pressed, and returns to Home on back', async () => {
      mockUseAuth.mockReturnValue({
        session,
        loading: false,
        login: jest.fn<(email: string, password: string) => Promise<void>>(),
        logout: jest.fn<() => Promise<void>>(),
      });
      mockGetAccessToken.mockResolvedValue('token');
      mockGetConnectivity.mockResolvedValue('online');
      mockGetDayPlan.mockResolvedValue(dayPlan);
      mockGetMyTickets.mockResolvedValue({ items: [], cursor: null });

      renderHome();
      await waitFor(() => expect(screen.getByTestId('notifications-button')).toBeTruthy());

      fireEvent.press(screen.getByTestId('notifications-button'));

      expect(screen.getByTestId('mock-notifications-screen')).toBeTruthy();
      expect(screen.queryByTestId('screen-home')).toBeNull();

      fireEvent.press(screen.getByTestId('mock-notifications-screen'));

      expect(screen.getByTestId('screen-home')).toBeTruthy();
    });

    it('shows an unread-count badge when there are unread notifications', async () => {
      mockUseAuth.mockReturnValue({
        session,
        loading: false,
        login: jest.fn<(email: string, password: string) => Promise<void>>(),
        logout: jest.fn<() => Promise<void>>(),
      });
      mockGetAccessToken.mockResolvedValue('token');
      mockGetConnectivity.mockResolvedValue('online');
      mockGetDayPlan.mockResolvedValue(dayPlan);
      mockGetMyTickets.mockResolvedValue({ items: [], cursor: null });
      mockGetNotifications.mockResolvedValue({ items: [], unreadCount: 4 });

      renderHome();

      await waitFor(() => expect(screen.getByTestId('notifications-unread-badge')).toBeTruthy());
      expect(screen.getByText('4')).toBeTruthy();
    });

    it('shows no badge when there are no unread notifications', async () => {
      mockUseAuth.mockReturnValue({
        session,
        loading: false,
        login: jest.fn<(email: string, password: string) => Promise<void>>(),
        logout: jest.fn<() => Promise<void>>(),
      });
      mockGetAccessToken.mockResolvedValue('token');
      mockGetConnectivity.mockResolvedValue('online');
      mockGetDayPlan.mockResolvedValue(dayPlan);
      mockGetMyTickets.mockResolvedValue({ items: [], cursor: null });

      renderHome();

      await waitFor(() => expect(screen.getByTestId('notifications-button')).toBeTruthy());
      expect(screen.queryByTestId('notifications-unread-badge')).toBeNull();
    });
  });
});
