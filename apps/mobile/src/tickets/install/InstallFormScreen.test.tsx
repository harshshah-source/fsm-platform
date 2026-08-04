import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { InstallFormScreen } from './InstallFormScreen';
import { apiInstallFitted, apiUploadMedia } from '../../api/client';
import { getAccessToken } from '../../auth/tokenStore';

jest.mock('../../api/client', () => {
  const actual = jest.requireActual('../../api/client') as object;
  return { ...actual, apiInstallFitted: jest.fn(), apiUploadMedia: jest.fn() };
});
jest.mock('../../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

const mockInstallFitted = jest.mocked(apiInstallFitted);
const mockUploadMedia = jest.mocked(apiUploadMedia);
const mockGetAccessToken = jest.mocked(getAccessToken);
const mockRequestPermission = jest.mocked(ImagePicker.requestCameraPermissionsAsync);
const mockLaunchCamera = jest.mocked(ImagePicker.launchCameraAsync);

async function capturePhoto() {
  mockRequestPermission.mockResolvedValue({ granted: true } as never);
  mockLaunchCamera.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///install.jpg', fileName: 'install.jpg', mimeType: 'image/jpeg' }],
  } as never);
  mockUploadMedia.mockResolvedValue({ photoRef: 'media-1', kind: 'INSTALL', slot: 'INSTALL_PHOTO' });
  fireEvent.press(screen.getByText('Install Photo'));
  await waitFor(() => expect(screen.getByTestId('slot-install-photo-filled')).toBeTruthy());
}

describe('InstallFormScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows the expected GPS serial from the ticket detail read as a hint', () => {
    render(
      <InstallFormScreen ticketId="t-1" expectedDeviceSerial="GPS502" onSubmitted={jest.fn()} onCancel={jest.fn()} />,
    );

    expect(screen.getByText(/GPS502/)).toBeTruthy();
  });

  it('disables submit until both GPS serial and SIM serial are non-empty; a photo is not required', () => {
    render(
      <InstallFormScreen ticketId="t-1" expectedDeviceSerial="GPS502" onSubmitted={jest.fn()} onCancel={jest.fn()} />,
    );

    expect(screen.getByTestId('install-submit').props.accessibilityState.disabled).toBe(true);

    fireEvent.changeText(screen.getByTestId('install-gps-serial-input'), 'GPS502');
    expect(screen.getByTestId('install-submit').props.accessibilityState.disabled).toBe(true);

    fireEvent.changeText(screen.getByTestId('install-sim-serial-input'), '8991000');
    expect(screen.getByTestId('install-submit').props.accessibilityState.disabled).toBe(false);
  });

  it('uploads a captured photo to the INSTALL_PHOTO slot and includes it in submit', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockInstallFitted.mockResolvedValue({
      ticketId: 't-1', status: 'ACTIVATED', deviceId: 'GPS502', assignedSeId: 'se-1',
      fittedGpsSerial: 'GPS502', fittedSimSerial: '8991000', fittedPhotoRef: 'media-1',
      fittedAt: '2026-08-04T00:00:00Z', activatedAt: '2026-08-04T00:00:00Z', closedAt: null,
    });
    const onSubmitted = jest.fn();

    render(
      <InstallFormScreen ticketId="t-1" expectedDeviceSerial="GPS502" onSubmitted={onSubmitted} onCancel={jest.fn()} />,
    );
    fireEvent.changeText(screen.getByTestId('install-gps-serial-input'), 'GPS502');
    fireEvent.changeText(screen.getByTestId('install-sim-serial-input'), '8991000');
    await capturePhoto();

    expect(mockUploadMedia).toHaveBeenCalledWith('token', 'INSTALL', 'INSTALL_PHOTO', {
      uri: 'file:///install.jpg',
      name: 'install.jpg',
      type: 'image/jpeg',
    });

    fireEvent.press(screen.getByTestId('install-submit'));

    await waitFor(() =>
      expect(mockInstallFitted).toHaveBeenCalledWith('token', 't-1', {
        gpsDeviceSerial: 'GPS502',
        simSerial: '8991000',
        photoRef: 'media-1',
      }),
    );
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });

  it('submits with no photo captured (optional)', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockInstallFitted.mockResolvedValue({
      ticketId: 't-1', status: 'ACTIVATED', deviceId: 'GPS502', assignedSeId: 'se-1',
      fittedGpsSerial: 'GPS502', fittedSimSerial: '8991000', fittedPhotoRef: null,
      fittedAt: '2026-08-04T00:00:00Z', activatedAt: '2026-08-04T00:00:00Z', closedAt: null,
    });

    render(
      <InstallFormScreen ticketId="t-1" expectedDeviceSerial="GPS502" onSubmitted={jest.fn()} onCancel={jest.fn()} />,
    );
    fireEvent.changeText(screen.getByTestId('install-gps-serial-input'), 'GPS502');
    fireEvent.changeText(screen.getByTestId('install-sim-serial-input'), '8991000');

    fireEvent.press(screen.getByTestId('install-submit'));

    await waitFor(() =>
      expect(mockInstallFitted).toHaveBeenCalledWith('token', 't-1', { gpsDeviceSerial: 'GPS502', simSerial: '8991000' }),
    );
  });

  it('renders an inline error when the server rejects the GPS serial (INVALID_SERIAL)', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockInstallFitted.mockRejectedValue(new Error('INVALID_SERIAL'));
    const onSubmitted = jest.fn();

    render(
      <InstallFormScreen ticketId="t-1" expectedDeviceSerial="GPS502" onSubmitted={onSubmitted} onCancel={jest.fn()} />,
    );
    fireEvent.changeText(screen.getByTestId('install-gps-serial-input'), 'wrong-serial');
    fireEvent.changeText(screen.getByTestId('install-sim-serial-input'), '8991000');

    fireEvent.press(screen.getByTestId('install-submit'));

    await waitFor(() => expect(screen.getByTestId('install-form-error')).toBeTruthy());
    expect(screen.getByText('INVALID_SERIAL')).toBeTruthy();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('calls onCancel when Back is pressed', () => {
    const onCancel = jest.fn();
    render(
      <InstallFormScreen ticketId="t-1" expectedDeviceSerial="GPS502" onSubmitted={jest.fn()} onCancel={onCancel} />,
    );

    fireEvent.press(screen.getByTestId('install-form-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
