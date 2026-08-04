import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import type { DayPlanView, MeTicketRow, SessionView } from '@fsm/shared';
import { HomeScreen } from './HomeScreen';
import { apiGetDayPlan, apiGetMyTickets, apiGetNotifications } from '../../api/client';
import { getConnectivityState } from '../../api/connectivity';
import { useAuth } from '../../auth/AuthProvider';
import { getAccessToken } from '../../auth/tokenStore';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return { ...actual, apiGetDayPlan: jest.fn(), apiGetMyTickets: jest.fn(), apiGetNotifications: jest.fn() };
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
  });

  it('renders the SE name/zone from the session profile', async () => {
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
    expect(screen.getByText('WEST')).toBeTruthy();
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
