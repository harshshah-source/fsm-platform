import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import type { MeTicketDetailView, VerificationView } from '@fsm/shared';
import { TicketDetailScreen } from './TicketDetailScreen';
import {
  apiGetTicketDetail,
  apiGetTicketVerification,
  apiRecoveryOnSite,
  apiSetSoftState,
  SoftStateConflictError,
} from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { captureLocation } from './captureLocation';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return {
    ...actual,
    apiGetTicketDetail: jest.fn(),
    apiGetTicketVerification: jest.fn(),
    apiSetSoftState: jest.fn(),
    apiRecoveryOnSite: jest.fn(),
  };
});
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));
jest.mock('./captureLocation', () => ({ captureLocation: jest.fn() }));
// Unit-test the navigation wiring only — TroubleshootFormScreen's own behavior is covered by its
// own test file.
jest.mock('../troubleshoot/TroubleshootFormScreen', () => {
  const { Text } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    TroubleshootFormScreen: ({ onSubmitted }: { onSubmitted: () => void }) => (
      <Text testID="mock-troubleshoot-form" onPress={onSubmitted}>
        Troubleshoot Form
      </Text>
    ),
  };
});
jest.mock('../verification/VerificationScreen', () => {
  const { Text } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    VerificationScreen: ({ onBack }: { onBack: () => void }) => (
      <Text testID="mock-verification-screen" onPress={onBack}>
        Verification
      </Text>
    ),
  };
});
jest.mock('../vehicle-unavailability/VehicleUnavailabilityFormScreen', () => {
  const { Text } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    VehicleUnavailabilityFormScreen: ({ onSubmitted }: { onSubmitted: () => void }) => (
      <Text testID="mock-vu-form" onPress={onSubmitted}>
        Vehicle Unavailability Form
      </Text>
    ),
  };
});
jest.mock('../recovery/CollectionFormScreen', () => {
  const { Text } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    CollectionFormScreen: ({ onSubmitted }: { onSubmitted: () => void }) => (
      <Text testID="mock-collection-form" onPress={onSubmitted}>
        Collection Form
      </Text>
    ),
  };
});
jest.mock('../recovery/UnableToCollectScreen', () => {
  const { Text } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    UnableToCollectScreen: ({ onSubmitted }: { onSubmitted: () => void }) => (
      <Text testID="mock-unable-to-collect" onPress={onSubmitted}>
        Unable To Collect
      </Text>
    ),
  };
});

const mockGetDetail = jest.mocked(apiGetTicketDetail);
const mockGetVerification = jest.mocked(apiGetTicketVerification);
const mockSetSoftState = jest.mocked(apiSetSoftState);
const mockRecoveryOnSite = jest.mocked(apiRecoveryOnSite);
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
    transporterContact: '+91-9000000000',
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
    expect(screen.getByText(/Rapid Fleet/)).toBeTruthy();
    expect(mockGetVerification).not.toHaveBeenCalled();
  });

  it('renders the verification-pending state and fetches the verification view', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(detail({ status: 'VERIFICATION_PENDING' }));
    const verification: VerificationView = {
      ticketId: 't-1',
      deviceId: 'GPS502',
      phase: 'PHASE_1_PASS',
      pingsReceivedCount: 2,
      outcome: null,
      fraudFlag: false,
      firstPingDistanceMeters: 120,
      badge: 'PARTIAL_RECOVERY',
      checks: [],
      startedAt: '2026-05-11T16:00:00Z',
      partialDeadline: '2026-05-12T16:00:00Z',
    };
    mockGetVerification.mockResolvedValue(verification);
    mockSetSoftState.mockResolvedValue({ result: 'OK', softState: {} as never });

    render(<TicketDetailScreen ticketId="t-1" />);

    await waitFor(() => expect(screen.getByTestId('verification-pending-card')).toBeTruthy());
    expect(mockGetVerification).toHaveBeenCalledWith('token', 't-1');
    expect(screen.getByText('PARTIAL_RECOVERY')).toBeTruthy();
  });

  it('opens VerificationScreen on View Verification, and returns to the detail view on back', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockGetDetail.mockResolvedValue(detail({ status: 'VERIFICATION_PENDING' }));
    mockGetVerification.mockResolvedValue({
      ticketId: 't-1',
      deviceId: 'GPS502',
      phase: 'PHASE_1_PASS',
      pingsReceivedCount: 2,
      outcome: null,
      fraudFlag: false,
      firstPingDistanceMeters: 120,
      badge: 'PARTIAL_RECOVERY',
      checks: [],
      startedAt: '2026-05-11T16:00:00Z',
      partialDeadline: '2026-05-12T16:00:00Z',
    });

    render(<TicketDetailScreen ticketId="t-1" />);
    await waitFor(() => expect(screen.getByTestId('view-verification-button')).toBeTruthy());

    fireEvent.press(screen.getByTestId('view-verification-button'));

    expect(screen.getByTestId('mock-verification-screen')).toBeTruthy();
    expect(screen.queryByTestId('screen-ticket-detail')).toBeNull();

    fireEvent.press(screen.getByTestId('mock-verification-screen'));

    expect(screen.getByTestId('screen-ticket-detail')).toBeTruthy();
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

  describe('Start Troubleshooting (#58 wiring)', () => {
    it('shows a Start Troubleshooting button once ON_SITE, which posts TROUBLESHOOT_STARTED and opens the form', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ activeSoftState: 'ON_SITE' }));
      mockSetSoftState.mockResolvedValue({ result: 'OK', softState: {} as never });

      render(<TicketDetailScreen ticketId="t-1" />);
      await waitFor(() => expect(screen.getByTestId('start-troubleshooting-button')).toBeTruthy());

      fireEvent.press(screen.getByTestId('start-troubleshooting-button'));

      await waitFor(() =>
        expect(mockSetSoftState).toHaveBeenCalledWith('token', 't-1', { target: 'TROUBLESHOOT_STARTED' }),
      );
      expect(screen.getByTestId('mock-troubleshoot-form')).toBeTruthy();
    });

    it('does not show Start Troubleshooting before ON_SITE', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ activeSoftState: null }));
      mockSetSoftState.mockResolvedValue({ result: 'OK', softState: {} as never });

      render(<TicketDetailScreen ticketId="t-1" />);

      await waitFor(() => expect(screen.getByTestId('on-site-button')).toBeTruthy());
      expect(screen.queryByTestId('start-troubleshooting-button')).toBeNull();
    });

    it('returns to the detail view and refetches once the form submits', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ activeSoftState: 'ON_SITE' }));
      mockSetSoftState.mockResolvedValue({ result: 'OK', softState: {} as never });

      render(<TicketDetailScreen ticketId="t-1" />);
      await waitFor(() => expect(screen.getByTestId('start-troubleshooting-button')).toBeTruthy());
      fireEvent.press(screen.getByTestId('start-troubleshooting-button'));
      await waitFor(() => expect(screen.getByTestId('mock-troubleshoot-form')).toBeTruthy());

      mockGetDetail.mockResolvedValueOnce(detail({ status: 'VERIFICATION_PENDING' }));
      fireEvent.press(screen.getByTestId('mock-troubleshoot-form'));

      await waitFor(() => expect(mockGetDetail).toHaveBeenCalledTimes(2));
      expect(screen.queryByTestId('mock-troubleshoot-form')).toBeNull();
    });
  });

  describe('#64/#171 — transporter contact + Vehicle Unavailability', () => {
    it('tapping the transporter calls Linking.openURL with tel:<contact>', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ transporterName: 'Rapid Fleet', transporterContact: '+91-9000000000' }));

      const { Linking } = jest.requireActual('react-native') as typeof import('react-native');
      const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

      render(<TicketDetailScreen ticketId="t-1" />);
      await waitFor(() => expect(screen.getByTestId('transporter-call-button')).toBeTruthy());
      fireEvent.press(screen.getByTestId('transporter-call-button'));

      expect(openURL).toHaveBeenCalledWith('tel:+91-9000000000');
      openURL.mockRestore();
    });

    it('renders an honest "no contact on file" state when transporterContact is null', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ transporterName: 'Rapid Fleet', transporterContact: null }));

      render(<TicketDetailScreen ticketId="t-1" />);

      await waitFor(() => expect(screen.getByTestId('transporter-no-contact')).toBeTruthy());
      expect(screen.queryByTestId('transporter-call-button')).toBeNull();
    });

    it('opens the Vehicle Unavailability form and returns to the detail view, refetching, on submit', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({}));

      render(<TicketDetailScreen ticketId="t-1" />);
      await waitFor(() => expect(screen.getByTestId('report-vehicle-unavailable-button')).toBeTruthy());

      fireEvent.press(screen.getByTestId('report-vehicle-unavailable-button'));
      await waitFor(() => expect(screen.getByTestId('mock-vu-form')).toBeTruthy());

      fireEvent.press(screen.getByTestId('mock-vu-form'));

      await waitFor(() => expect(mockGetDetail).toHaveBeenCalledTimes(2));
      expect(screen.queryByTestId('mock-vu-form')).toBeNull();
    });
  });

  describe('#68 — RECOVERY work-type card', () => {
    it('renders a recovery card with the lifecycle status, and never auto-posts VIEWED (RECOVERY has no soft-state chain)', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ workType: 'RECOVERY', status: 'SCHEDULED' }));

      render(<TicketDetailScreen ticketId="t-1" />);

      await waitFor(() => expect(screen.getByTestId('recovery-card')).toBeTruthy());
      expect(screen.getByText(/Scheduled/)).toBeTruthy();
      expect(mockSetSoftState).not.toHaveBeenCalled();
      expect(screen.queryByTestId('ready-card')).toBeNull();
    });

    it('shows Mark On-Site only while SCHEDULED, posts it, and refetches on success', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ workType: 'RECOVERY', status: 'SCHEDULED' }));
      mockRecoveryOnSite.mockResolvedValue({
        ticketId: 't-1', status: 'ON_SITE', deviceId: 'GPS502', assignedSeId: 'se-1',
        collectedDeviceSerial: null, collectionConditionNotes: null, unableToCollectReason: null,
        closureType: null, closedAt: null,
      });

      render(<TicketDetailScreen ticketId="t-1" />);
      await waitFor(() => expect(screen.getByTestId('recovery-onsite-button')).toBeTruthy());

      fireEvent.press(screen.getByTestId('recovery-onsite-button'));

      await waitFor(() => expect(mockRecoveryOnSite).toHaveBeenCalledWith('token', 't-1'));
      await waitFor(() => expect(mockGetDetail).toHaveBeenCalledTimes(2));
    });

    it('does not show Mark On-Site once past SCHEDULED', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ workType: 'RECOVERY', status: 'ON_SITE' }));

      render(<TicketDetailScreen ticketId="t-1" />);

      await waitFor(() => expect(screen.getByTestId('recovery-card')).toBeTruthy());
      expect(screen.queryByTestId('recovery-onsite-button')).toBeNull();
    });

    it('shows Collection Form and Unable to Collect only while ON_SITE, opening the respective screens and refetching on submit', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ workType: 'RECOVERY', status: 'ON_SITE' }));

      render(<TicketDetailScreen ticketId="t-1" />);
      await waitFor(() => expect(screen.getByTestId('recovery-collection-form-button')).toBeTruthy());
      expect(screen.getByTestId('recovery-unable-button')).toBeTruthy();

      fireEvent.press(screen.getByTestId('recovery-collection-form-button'));
      expect(screen.getByTestId('mock-collection-form')).toBeTruthy();

      mockGetDetail.mockResolvedValueOnce(detail({ workType: 'RECOVERY', status: 'COLLECTED' }));
      fireEvent.press(screen.getByTestId('mock-collection-form'));

      await waitFor(() => expect(mockGetDetail).toHaveBeenCalledTimes(2));
      expect(screen.queryByTestId('mock-collection-form')).toBeNull();
    });

    it('opens Unable to Collect and refetches on submit', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ workType: 'RECOVERY', status: 'ON_SITE' }));

      render(<TicketDetailScreen ticketId="t-1" />);
      await waitFor(() => expect(screen.getByTestId('recovery-unable-button')).toBeTruthy());

      fireEvent.press(screen.getByTestId('recovery-unable-button'));
      expect(screen.getByTestId('mock-unable-to-collect')).toBeTruthy();

      fireEvent.press(screen.getByTestId('mock-unable-to-collect'));

      await waitFor(() => expect(mockGetDetail).toHaveBeenCalledTimes(2));
      expect(screen.queryByTestId('mock-unable-to-collect')).toBeNull();
    });

    it('shows no action buttons once COLLECTED', async () => {
      mockGetAccessToken.mockResolvedValue('token');
      mockGetDetail.mockResolvedValue(detail({ workType: 'RECOVERY', status: 'COLLECTED' }));

      render(<TicketDetailScreen ticketId="t-1" />);

      await waitFor(() => expect(screen.getByTestId('recovery-card')).toBeTruthy());
      expect(screen.queryByTestId('recovery-onsite-button')).toBeNull();
      expect(screen.queryByTestId('recovery-collection-form-button')).toBeNull();
      expect(screen.queryByTestId('recovery-unable-button')).toBeNull();
    });
  });
});
