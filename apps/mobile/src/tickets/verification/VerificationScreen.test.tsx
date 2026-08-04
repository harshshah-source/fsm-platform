import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import type { VerificationView } from '@fsm/shared';
import { VerificationScreen } from './VerificationScreen';
import { apiGetTicketVerification } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return { ...actual, apiGetTicketVerification: jest.fn() };
});
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));

const mockGetVerification = jest.mocked(apiGetTicketVerification);
const mockGetAccessToken = jest.mocked(getAccessToken);

function view(overrides: Partial<VerificationView>): VerificationView {
  return {
    ticketId: 't-1',
    deviceId: 'GPS909',
    phase: 'PENDING',
    pingsReceivedCount: 1,
    outcome: null,
    fraudFlag: false,
    firstPingDistanceMeters: null,
    badge: 'PARTIAL_RECOVERY',
    checks: [
      { key: 'live_gps', label: 'Live GPS received', state: 'PASS' },
      { key: 'multiple_pings', label: 'Multiple pings detected', state: 'PENDING' },
      { key: 'stability_window', label: 'Stability window', state: 'PENDING' },
    ],
    startedAt: '2026-05-11T16:00:00Z',
    partialDeadline: '2026-05-12T16:00:00Z',
    ...overrides,
  };
}

describe('VerificationScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the Device Guard card with the anchored deviceId', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetVerification.mockResolvedValue(view({}));

    render(<VerificationScreen ticketId="t-1" ticketNoDisplay="TCK-10252" ticketStatus="VERIFICATION_PENDING" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('GPS909 only')).toBeTruthy());
  });

  it('renders each check with its real state', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetVerification.mockResolvedValue(view({}));

    render(<VerificationScreen ticketId="t-1" ticketNoDisplay="TCK-10252" ticketStatus="VERIFICATION_PENDING" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByTestId('check-live_gps')).toBeTruthy());
    expect(screen.getByText('Live GPS received')).toBeTruthy();
    expect(screen.getByText('Multiple pings detected')).toBeTruthy();
    expect(screen.getByText('Stability window')).toBeTruthy();
  });

  it('shows the Escalated badge when the ticket status is ESCALATED, independent of the verification badge', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetVerification.mockResolvedValue(view({ badge: null, outcome: null }));

    render(<VerificationScreen ticketId="t-1" ticketNoDisplay="TCK-10252" ticketStatus="ESCALATED" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByTestId('escalated-badge')).toBeTruthy());
  });

  it('does not show the Escalated badge for a normal ticket status', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetVerification.mockResolvedValue(view({}));

    render(<VerificationScreen ticketId="t-1" ticketNoDisplay="TCK-10252" ticketStatus="VERIFICATION_PENDING" onBack={jest.fn()} />);

    await waitFor(() => expect(screen.getByTestId('check-live_gps')).toBeTruthy());
    expect(screen.queryByTestId('escalated-badge')).toBeNull();
  });

  it('calls onBack when Back to Ticket is pressed', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetVerification.mockResolvedValue(view({}));
    const onBack = jest.fn();

    render(<VerificationScreen ticketId="t-1" ticketNoDisplay="TCK-10252" ticketStatus="VERIFICATION_PENDING" onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('back-to-ticket-button')).toBeTruthy());
    fireEvent.press(screen.getByTestId('back-to-ticket-button'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
