import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import type { MeTicketDetailView, VerificationView } from '@fsm/shared';
import { TicketDetailScreen } from './TicketDetailScreen';
import { apiGetTicketDetail, apiGetTicketVerification, apiSetSoftState, SoftStateConflictError } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { captureLocation } from './captureLocation';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return {
    ...actual,
    apiGetTicketDetail: jest.fn(),
    apiGetTicketVerification: jest.fn(),
    apiSetSoftState: jest.fn(),
  };
});
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));
jest.mock('./captureLocation', () => ({ captureLocation: jest.fn() }));

const mockGetDetail = jest.mocked(apiGetTicketDetail);
const mockGetVerification = jest.mocked(apiGetTicketVerification);
const mockSetSoftState = jest.mocked(apiSetSoftState);
const mockGetAccessToken = jest.mocked(getAccessToken);
const mockCaptureLocation = jest.mocked(captureLocation);

function detail(overrides: Partial<MeTicketDetailView>): MeTicketDetailView {
  return {
    ticketId: 't-1',
    ticketNo: 306,
    ticketNoDisplay: 'TCK-00306',
    deviceId: 'GPS502',
    vehicleNo: 'KA05 CD 8845',
    plantName: 'L&T - Bengaluru Plant',
    companyName: 'L&T',
    companyTier: 'GOLD',
    transporterName: 'Rapid Fleet',
    slaBucket: 'CRITICAL',
    workType: 'TROUBLESHOOT',
    status: 'OPEN',
    activeSoftState: null,
    createdAt: '2026-05-01T00:00:00Z',
    lastStateChangedAt: '2026-05-09T21:15:00Z',
    failureCycleHistory: [],
    expectedComponents: [],
    componentRequestStatus: null,
    waitingComponentSince: null,
    readinessHint: 'UNKNOWN',
    technicalHealth: { hints: [], rawTelemetry: null, dataAsOf: null, available: false },
    ...overrides,
  };
}

describe('TicketDetailScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the ready state from the detail read, without fetching verification', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(detail({}));
    mockSetSoftState.mockResolvedValue({ result: 'OK', softState: {} as never });

    render(<TicketDetailScreen ticketId="t-1" />);

    await waitFor(() => expect(screen.getByText('KA05 CD 8845')).toBeTruthy());
    expect(screen.getByText('TCK-00306')).toBeTruthy();
    expect(screen.getByText('L&T - Bengaluru Plant')).toBeTruthy();
    expect(screen.getByText('Rapid Fleet')).toBeTruthy();
    expect(mockGetVerification).not.toHaveBeenCalled();
  });

  it('renders the verification-pending state and fetches the verification view', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(detail({ status: 'VERIFICATION_PENDING' }));
    const verification: VerificationView = {
      ticketId: 't-1',
      phase: 'PHASE_1_PASS',
      pingsReceivedCount: 2,
      outcome: null,
      fraudFlag: false,
      firstPingDistanceMeters: 120,
      badge: 'PARTIAL_RECOVERY',
    };
    mockGetVerification.mockResolvedValue(verification);
    mockSetSoftState.mockResolvedValue({ result: 'OK', softState: {} as never });

    render(<TicketDetailScreen ticketId="t-1" />);

    await waitFor(() => expect(screen.getByTestId('verification-pending-card')).toBeTruthy());
    expect(mockGetVerification).toHaveBeenCalledWith('token', 't-1');
    expect(screen.getByText('PARTIAL_RECOVERY')).toBeTruthy();
  });

  it('renders a not-found state on TICKET_NOT_FOUND', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockRejectedValue(new Error('TICKET_NOT_FOUND'));

    render(<TicketDetailScreen ticketId="missing" />);

    await waitFor(() => expect(screen.getByTestId('ticket-detail-not-found')).toBeTruthy());
  });

  it('shows Technical Health hints when available', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(
      detail({
        technicalHealth: {
          hints: [{ code: 'NO_MAIN_POWER', severity: 8, label: 'No main power — check fuse' }],
          rawTelemetry: null,
          dataAsOf: '2026-05-11T16:15:00Z',
          available: true,
        },
      }),
    );
    mockSetSoftState.mockResolvedValue({ result: 'OK', softState: {} as never });

    render(<TicketDetailScreen ticketId="t-1" />);

    await waitFor(() => expect(screen.getByText('No main power — check fuse')).toBeTruthy());
  });

  describe('soft-state actions', () => {
    it('auto-posts VIEWED once the ready state loads, when there is no active soft state yet', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ activeSoftState: null }));
      mockSetSoftState.mockResolvedValue({ result: 'OK', softState: {} as never });

      render(<TicketDetailScreen ticketId="t-1" />);

      await waitFor(() => expect(mockSetSoftState).toHaveBeenCalledWith('token', 't-1', { target: 'VIEWED' }));
    });

    it('does not auto-post VIEWED when the SE already holds ON_SITE (would be an invalid backward transition)', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ activeSoftState: 'ON_SITE' }));

      render(<TicketDetailScreen ticketId="t-1" />);

      await waitFor(() => expect(screen.getByTestId('screen-ticket-detail')).toBeTruthy());
      expect(mockSetSoftState).not.toHaveBeenCalled();
    });

    it('shows the ON_SITE button when no active soft state blocks it, and posts a captured location on press', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ activeSoftState: null }));
      mockSetSoftState.mockResolvedValue({ result: 'OK', softState: {} as never });
      mockCaptureLocation.mockResolvedValue({ lat: 12.9, lng: 77.6 });

      render(<TicketDetailScreen ticketId="t-1" />);
      await waitFor(() => expect(mockSetSoftState).toHaveBeenCalledWith('token', 't-1', { target: 'VIEWED' }));
      mockSetSoftState.mockClear();

      fireEvent.press(screen.getByTestId('on-site-button'));

      await waitFor(() =>
        expect(mockSetSoftState).toHaveBeenCalledWith('token', 't-1', {
          target: 'ON_SITE',
          location: { lat: 12.9, lng: 77.6 },
        }),
      );
    });

    it('posts ON_SITE with no location key when capture fails (Mark ON_SITE fallback)', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ activeSoftState: null }));
      mockSetSoftState.mockResolvedValue({ result: 'OK', softState: {} as never });
      mockCaptureLocation.mockResolvedValue(undefined);

      render(<TicketDetailScreen ticketId="t-1" />);
      await waitFor(() => expect(mockSetSoftState).toHaveBeenCalledWith('token', 't-1', { target: 'VIEWED' }));
      mockSetSoftState.mockClear();

      fireEvent.press(screen.getByTestId('on-site-button'));

      await waitFor(() => expect(mockSetSoftState).toHaveBeenCalledWith('token', 't-1', { target: 'ON_SITE' }));
    });

    it('does not show the ON_SITE button once already ON_SITE', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ activeSoftState: 'ON_SITE' }));

      render(<TicketDetailScreen ticketId="t-1" />);

      await waitFor(() => expect(screen.getByTestId('screen-ticket-detail')).toBeTruthy());
      expect(screen.queryByTestId('on-site-button')).toBeNull();
    });

    it('shows a conflict message on a 409 and re-fetches the detail', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ activeSoftState: null }));
      mockSetSoftState.mockResolvedValue({ result: 'OK', softState: {} as never });
      mockCaptureLocation.mockResolvedValue(undefined);

      render(<TicketDetailScreen ticketId="t-1" />);
      await waitFor(() => expect(mockSetSoftState).toHaveBeenCalledWith('token', 't-1', { target: 'VIEWED' }));

      mockSetSoftState.mockRejectedValueOnce(
        new SoftStateConflictError({ code: 'INVALID_SOFT_STATE_TRANSITION', from: 'ON_SITE', to: 'ON_SITE' }),
      );
      mockGetDetail.mockResolvedValueOnce(detail({ activeSoftState: 'ON_SITE' }));

      fireEvent.press(screen.getByTestId('on-site-button'));

      await waitFor(() => expect(screen.getByTestId('soft-state-conflict')).toBeTruthy());
      expect(mockGetDetail).toHaveBeenCalledTimes(2);
    });
  });

  it('renders a back button and calls onBack when pressed, given the prop', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(detail({ activeSoftState: 'ON_SITE' }));
    const onBack = jest.fn();

    render(<TicketDetailScreen ticketId="t-1" onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ticket-detail-back')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ticket-detail-back'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders a back button on the not-found state too, so a 404 is never a dead end', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockRejectedValue(new Error('TICKET_NOT_FOUND'));
    const onBack = jest.fn();

    render(<TicketDetailScreen ticketId="missing" onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('ticket-detail-back')).toBeTruthy());
    fireEvent.press(screen.getByTestId('ticket-detail-back'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders no back button when onBack is not given', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(detail({ activeSoftState: 'ON_SITE' }));

    render(<TicketDetailScreen ticketId="t-1" />);

    await waitFor(() => expect(screen.getByTestId('screen-ticket-detail')).toBeTruthy());
    expect(screen.queryByTestId('ticket-detail-back')).toBeNull();
  });
});
