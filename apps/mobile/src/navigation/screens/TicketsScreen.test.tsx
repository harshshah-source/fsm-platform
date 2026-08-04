import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import type { MeTicketRow, MeTicketsView } from '@fsm/shared';
import { TicketsScreen } from './TicketsScreen';
import { apiGetMyTickets } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { getConnectivityState } from '../../api/connectivity';

jest.mock('../../api/client', () => ({ apiGetMyTickets: jest.fn() }));
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));
jest.mock('../../api/connectivity', () => ({ getConnectivityState: jest.fn() }));

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
    ...overrides,
  };
}

describe('TicketsScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
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
});
