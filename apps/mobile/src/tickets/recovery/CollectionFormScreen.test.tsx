import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { CollectionFormScreen } from './CollectionFormScreen';
import { apiRecoveryMarkCollected } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return { ...actual, apiRecoveryMarkCollected: jest.fn() };
});
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));

const mockMarkCollected = jest.mocked(apiRecoveryMarkCollected);
const mockGetAccessToken = jest.mocked(getAccessToken);

describe('CollectionFormScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows the expected serial from the ticket detail read as a hint', () => {
    render(
      <CollectionFormScreen ticketId="t-1" expectedDeviceSerial="GPS502" onSubmitted={jest.fn()} onCancel={jest.fn()} />,
    );

    expect(screen.getByText(/GPS502/)).toBeTruthy();
  });

  it('disables submit until both serial and condition notes are non-empty', () => {
    render(
      <CollectionFormScreen ticketId="t-1" expectedDeviceSerial="GPS502" onSubmitted={jest.fn()} onCancel={jest.fn()} />,
    );

    expect(screen.getByTestId('collection-submit').props.accessibilityState.disabled).toBe(true);

    fireEvent.changeText(screen.getByTestId('collection-serial-input'), 'GPS502');
    expect(screen.getByTestId('collection-submit').props.accessibilityState.disabled).toBe(true);

    fireEvent.changeText(screen.getByTestId('collection-notes-input'), 'minor scratches');
    expect(screen.getByTestId('collection-submit').props.accessibilityState.disabled).toBe(false);
  });

  it('submits the serial and notes, calling onSubmitted on success', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockMarkCollected.mockResolvedValue({
      ticketId: 't-1', status: 'COLLECTED', deviceId: 'GPS502', assignedSeId: 'se-1',
      collectedDeviceSerial: 'GPS502', collectionConditionNotes: 'minor scratches',
      unableToCollectReason: null, closureType: null, closedAt: null,
    });
    const onSubmitted = jest.fn();

    render(
      <CollectionFormScreen ticketId="t-1" expectedDeviceSerial="GPS502" onSubmitted={onSubmitted} onCancel={jest.fn()} />,
    );
    fireEvent.changeText(screen.getByTestId('collection-serial-input'), 'GPS502');
    fireEvent.changeText(screen.getByTestId('collection-notes-input'), 'minor scratches');

    fireEvent.press(screen.getByTestId('collection-submit'));

    await waitFor(() =>
      expect(mockMarkCollected).toHaveBeenCalledWith('token', 't-1', { deviceSerial: 'GPS502', conditionNotes: 'minor scratches' }),
    );
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });

  it('renders an inline error and does not call onSubmitted when the server rejects the serial (INVALID_DEVICE_SERIAL)', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockMarkCollected.mockRejectedValue(new Error('INVALID_DEVICE_SERIAL'));
    const onSubmitted = jest.fn();

    render(
      <CollectionFormScreen ticketId="t-1" expectedDeviceSerial="GPS502" onSubmitted={onSubmitted} onCancel={jest.fn()} />,
    );
    fireEvent.changeText(screen.getByTestId('collection-serial-input'), 'wrong-serial');
    fireEvent.changeText(screen.getByTestId('collection-notes-input'), 'ok');

    fireEvent.press(screen.getByTestId('collection-submit'));

    await waitFor(() => expect(screen.getByTestId('collection-form-error')).toBeTruthy());
    expect(screen.getByText('INVALID_DEVICE_SERIAL')).toBeTruthy();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('calls onCancel when Back is pressed', () => {
    const onCancel = jest.fn();
    render(
      <CollectionFormScreen ticketId="t-1" expectedDeviceSerial="GPS502" onSubmitted={jest.fn()} onCancel={onCancel} />,
    );

    fireEvent.press(screen.getByTestId('collection-form-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
