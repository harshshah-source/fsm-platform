import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { VoucherFormScreen } from './VoucherFormScreen';
import { apiCreateVoucher, apiUploadMedia } from '../api/client';
import { getAccessToken } from '../auth/tokenStore';

jest.mock('../api/client', () => {
  const actual = jest.requireActual('../api/client') as object;
  return { ...actual, apiCreateVoucher: jest.fn(), apiUploadMedia: jest.fn() };
});
jest.mock('../auth/tokenStore', () => ({ getAccessToken: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => `uuid-${Math.random()}`) }));
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

const mockCreateVoucher = jest.mocked(apiCreateVoucher);
const mockUploadMedia = jest.mocked(apiUploadMedia);
const mockGetAccessToken = jest.mocked(getAccessToken);
const mockRequestPermission = jest.mocked(ImagePicker.requestCameraPermissionsAsync);
const mockLaunchCamera = jest.mocked(ImagePicker.launchCameraAsync);

const createResponse = {
  voucher: { voucherId: 'v-1', seId: 'se-1', clientSubmissionId: 'x', status: 'ZONAL_MANAGER_REVIEW' as const, totalAmount: 250, submittedAt: null },
  duplicate: false,
};

async function capturePhoto() {
  mockRequestPermission.mockResolvedValue({ granted: true } as never);
  mockLaunchCamera.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file:///receipt.jpg', fileName: 'receipt.jpg', mimeType: 'image/jpeg' }],
  } as never);
  mockUploadMedia.mockResolvedValue({ photoRef: 'media-1', kind: 'VOUCHER', slot: 'RECEIPT' });
  fireEvent.press(screen.getByText('Receipt'));
  await waitFor(() => expect(screen.getByTestId('slot-receipt-filled')).toBeTruthy());
}

describe('VoucherFormScreen', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the category tile picker and a Receipt capture slot', () => {
    render(<VoucherFormScreen onSubmitted={jest.fn()} onCancel={jest.fn()} />);

    expect(screen.getByTestId('category-tile-TRAVEL')).toBeTruthy();
    expect(screen.getByTestId('category-tile-ACCOMMODATION')).toBeTruthy();
    expect(screen.getByTestId('voucher-amount')).toBeTruthy();
  });

  it('disables submit until amount, category, and a photo are all present', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    render(<VoucherFormScreen onSubmitted={jest.fn()} onCancel={jest.fn()} />);

    expect(screen.getByTestId('voucher-submit').props.accessibilityState?.disabled).toBe(true);

    fireEvent.changeText(screen.getByTestId('voucher-amount'), '250');
    fireEvent.press(screen.getByTestId('category-tile-TRAVEL'));
    expect(screen.getByTestId('voucher-submit').props.accessibilityState?.disabled).toBe(true);

    await capturePhoto();
    expect(screen.getByTestId('voucher-submit').props.accessibilityState?.disabled).toBe(false);
  });

  it('uploads the captured photo to the RECEIPT slot before enabling submit', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    render(<VoucherFormScreen onSubmitted={jest.fn()} onCancel={jest.fn()} />);

    await capturePhoto();

    expect(mockUploadMedia).toHaveBeenCalledWith('token', 'VOUCHER', 'RECEIPT', {
      uri: 'file:///receipt.jpg',
      name: 'receipt.jpg',
      type: 'image/jpeg',
    });
  });

  it('submits amount, category, and the uploaded photoRef; calls onSubmitted on success', async () => {
    mockGetAccessToken.mockResolvedValue('token');
    mockCreateVoucher.mockResolvedValue(createResponse);
    const onSubmitted = jest.fn();

    render(<VoucherFormScreen onSubmitted={onSubmitted} onCancel={jest.fn()} />);
    fireEvent.changeText(screen.getByTestId('voucher-amount'), '250');
    fireEvent.press(screen.getByTestId('category-tile-TRAVEL'));
    await capturePhoto();
    fireEvent.press(screen.getByTestId('voucher-submit'));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(mockCreateVoucher).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({
        items: [{ category: 'TRAVEL', amount: 250, photoRef: 'media-1' }],
      }),
    );
  });

  it('does not submit when no photo has been captured (PHOTO_REQUIRED, PRD §597.3)', () => {
    render(<VoucherFormScreen onSubmitted={jest.fn()} onCancel={jest.fn()} />);
    fireEvent.changeText(screen.getByTestId('voucher-amount'), '250');
    fireEvent.press(screen.getByTestId('category-tile-TRAVEL'));

    fireEvent.press(screen.getByTestId('voucher-submit'));

    expect(mockCreateVoucher).not.toHaveBeenCalled();
  });

  it('calls onCancel when Back is pressed', () => {
    const onCancel = jest.fn();
    render(<VoucherFormScreen onSubmitted={jest.fn()} onCancel={onCancel} />);

    fireEvent.press(screen.getByTestId('voucher-form-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
