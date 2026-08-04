import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { UnableToCollectScreen } from './UnableToCollectScreen';
import { apiRecoveryUnableToCollect } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return { ...actual, apiRecoveryUnableToCollect: jest.fn() };
});
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));

const mockUnableToCollect = jest.mocked(apiRecoveryUnableToCollect);
const mockGetAccessToken = jest.mocked(getAccessToken);

describe('UnableToCollectScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders all four reason tiles', () => {
    render(<UnableToCollectScreen ticketId="t-1" onSubmitted={jest.fn()} onCancel={jest.fn()} />);

    expect(screen.getByTestId('unable-reason-tile-COMPANY_REFUSED')).toBeTruthy();
    expect(screen.getByTestId('unable-reason-tile-VEHICLE_UNREACHABLE')).toBeTruthy();
    expect(screen.getByTestId('unable-reason-tile-DEVICE_MISSING')).toBeTruthy();
    expect(screen.getByTestId('unable-reason-tile-OTHER')).toBeTruthy();
  });

  it('disables submit until a reason is selected', () => {
    render(<UnableToCollectScreen ticketId="t-1" onSubmitted={jest.fn()} onCancel={jest.fn()} />);

    expect(screen.getByTestId('unable-submit').props.accessibilityState.disabled).toBe(true);

    fireEvent.press(screen.getByTestId('unable-reason-tile-DEVICE_MISSING'));

    expect(screen.getByTestId('unable-submit').props.accessibilityState.disabled).toBe(false);
  });

  it('posts the selected reason code and shows a ZM-queue confirmation on success', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockUnableToCollect.mockResolvedValue({
      ticketId: 't-1', status: 'ON_SITE', deviceId: 'GPS502', assignedSeId: 'se-1',
      collectedDeviceSerial: null, collectionConditionNotes: null,
      unableToCollectReason: 'DEVICE_MISSING', closureType: null, closedAt: null,
    });
    const onSubmitted = jest.fn();

    render(<UnableToCollectScreen ticketId="t-1" onSubmitted={onSubmitted} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('unable-reason-tile-DEVICE_MISSING'));
    fireEvent.press(screen.getByTestId('unable-submit'));

    await waitFor(() => expect(mockUnableToCollect).toHaveBeenCalledWith('token', 't-1', { reasonCode: 'DEVICE_MISSING' }));
    await waitFor(() => expect(screen.getByTestId('unable-confirmation')).toBeTruthy());
    expect(screen.getAllByText(/Zone Manager/).length).toBeGreaterThan(0);
    expect(onSubmitted).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('unable-confirmation-done'));
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('renders an inline error and stays on the form when the submit fails', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockUnableToCollect.mockRejectedValue(new Error('RECOVERY_WRONG_STATE'));

    render(<UnableToCollectScreen ticketId="t-1" onSubmitted={jest.fn()} onCancel={jest.fn()} />);
    fireEvent.press(screen.getByTestId('unable-reason-tile-OTHER'));
    fireEvent.press(screen.getByTestId('unable-submit'));

    await waitFor(() => expect(screen.getByTestId('unable-form-error')).toBeTruthy());
    expect(screen.getByText('RECOVERY_WRONG_STATE')).toBeTruthy();
    expect(screen.queryByTestId('unable-confirmation')).toBeNull();
  });

  it('calls onCancel when Back is pressed', () => {
    const onCancel = jest.fn();
    render(<UnableToCollectScreen ticketId="t-1" onSubmitted={jest.fn()} onCancel={onCancel} />);

    fireEvent.press(screen.getByTestId('unable-form-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
