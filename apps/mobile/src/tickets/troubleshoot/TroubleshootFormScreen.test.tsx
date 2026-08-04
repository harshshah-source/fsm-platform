import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { NavigationContainer } from '@react-navigation/native';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import type { TroubleshootSubmitResponse } from '@fsm/shared';
import { TroubleshootFormScreen } from './TroubleshootFormScreen';
import { apiSubmitTroubleshoot, TroubleshootConflictError } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';
import { captureLocation } from '../detail/captureLocation';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return { ...actual, apiSubmitTroubleshoot: jest.fn() };
});
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));
jest.mock('../detail/captureLocation', () => ({ captureLocation: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => `uuid-${Math.random()}`) }));

const mockSubmit = jest.mocked(apiSubmitTroubleshoot);
const mockGetAccessToken = jest.mocked(getAccessToken);
const mockCaptureLocation = jest.mocked(captureLocation);

const response: TroubleshootSubmitResponse = {
  result: 'OK',
  duplicate: false,
  submission: {
    submissionId: 's-1',
    ticketId: 't-1',
    seId: 'se-1',
    clientSubmissionId: 'whatever',
    rootCauseCategory: 'POWER_ISSUE',
    componentUnavailable: false,
    presenceSource: 'FORM_GPS',
    seGpsLat: 12.9,
    seGpsLon: 77.6,
    submittedAt: '2026-05-11T16:15:00Z',
  },
};

describe('TroubleshootFormScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the Issue Found and Action Taken tile pickers', () => {
    render(<TroubleshootFormScreen ticketId="t-1" onSubmitted={jest.fn()} />);

    expect(screen.getByTestId('issue-tile-POWER_ISSUE')).toBeTruthy();
    expect(screen.getByTestId('issue-tile-WIRING_ISSUE')).toBeTruthy();
    expect(screen.getByTestId('action-tile-Restart')).toBeTruthy();
  });

  it('disables submit until a root cause is selected', () => {
    render(<TroubleshootFormScreen ticketId="t-1" onSubmitted={jest.fn()} />);

    expect(screen.getByTestId('troubleshoot-submit').props.accessibilityState?.disabled).toBe(true);
  });

  it('submits with the selected root cause, notes, and a fresh clientSubmissionId; calls onSubmitted on success', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockCaptureLocation.mockResolvedValue({ lat: 12.9, lng: 77.6 });
    mockSubmit.mockResolvedValue(response);
    const onSubmitted = jest.fn();

    render(<TroubleshootFormScreen ticketId="t-1" onSubmitted={onSubmitted} />);
    fireEvent.press(screen.getByTestId('issue-tile-POWER_ISSUE'));
    fireEvent.press(screen.getByTestId('action-tile-Restart'));
    fireEvent.changeText(screen.getByTestId('root-cause-notes'), 'No power at unit');
    fireEvent.press(screen.getByTestId('troubleshoot-submit'));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));

    expect(mockSubmit).toHaveBeenCalledWith(
      'token',
      't-1',
      expect.objectContaining({
        rootCauseCategory: 'POWER_ISSUE',
        actionTakenCategory: 'Restart',
        rootCauseNotes: 'No power at unit',
        seGps: { lat: 12.9, lon: 77.6 },
      }),
    );
    const [, , sentBody] = mockSubmit.mock.calls[0];
    expect(typeof sentBody.clientSubmissionId).toBe('string');
    expect(sentBody.clientSubmissionId.length).toBeGreaterThan(0);
  });

  it('omits seGps when no location was captured', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockCaptureLocation.mockResolvedValue(undefined);
    mockSubmit.mockResolvedValue(response);

    render(<TroubleshootFormScreen ticketId="t-1" onSubmitted={jest.fn()} />);
    fireEvent.press(screen.getByTestId('issue-tile-POWER_ISSUE'));
    fireEvent.press(screen.getByTestId('troubleshoot-submit'));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    const [, , sentBody] = mockSubmit.mock.calls[0];
    expect('seGps' in sentBody).toBe(false);
  });

  it('generates a new clientSubmissionId on a second submit (resubmit)', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockCaptureLocation.mockResolvedValue(undefined);
    mockSubmit.mockResolvedValue(response);

    render(<TroubleshootFormScreen ticketId="t-1" onSubmitted={jest.fn()} />);
    fireEvent.press(screen.getByTestId('issue-tile-POWER_ISSUE'));
    fireEvent.press(screen.getByTestId('troubleshoot-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));

    fireEvent.press(screen.getByTestId('troubleshoot-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(2));

    const firstId = mockSubmit.mock.calls[0][2].clientSubmissionId;
    const secondId = mockSubmit.mock.calls[1][2].clientSubmissionId;
    expect(secondId).not.toBe(firstId);
  });

  it('shows the full-screen #63 ConflictScreen on TroubleshootConflictError (409), not a crash', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockCaptureLocation.mockResolvedValue(undefined);
    mockSubmit.mockRejectedValue(
      new TroubleshootConflictError({
        code: 'TICKET_ALREADY_CLOSED',
        status: 'CLOSED',
        winnerSeId: 'se-2',
        winnerSeName: 'SE South',
        winnerAt: '2026-05-11T16:00:00Z',
        shadowUseRecorded: true,
      }),
    );

    render(
      <NavigationContainer>
        <TroubleshootFormScreen ticketId="t-1" onSubmitted={jest.fn()} />
      </NavigationContainer>,
    );
    fireEvent.press(screen.getByTestId('issue-tile-POWER_ISSUE'));
    fireEvent.press(screen.getByTestId('troubleshoot-submit'));

    await waitFor(() => expect(screen.getByTestId('screen-troubleshoot-conflict')).toBeTruthy());
    expect(screen.queryByTestId('screen-troubleshoot-form')).toBeNull();
  });
});
