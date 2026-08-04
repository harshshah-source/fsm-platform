import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import type { DayPlanView, MeTicketRow, SessionView } from '@fsm/shared';
import { HomeScreen } from './HomeScreen';
import { apiGetDayPlan, apiGetMyTickets } from '../../api/client';
import { getConnectivityState } from '../../api/connectivity';
import { useAuth } from '../../auth/AuthProvider';
import { getAccessToken } from '../../auth/tokenStore';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return { ...actual, apiGetDayPlan: jest.fn(), apiGetMyTickets: jest.fn() };
});
jest.mock('../../api/connectivity', () => ({ getConnectivityState: jest.fn() }));
jest.mock('../../auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));

const mockGetDayPlan = jest.mocked(apiGetDayPlan);
const mockGetMyTickets = jest.mocked(apiGetMyTickets);
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
});
