import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as Location from 'expo-location';
import { captureLocation } from './captureLocation';

jest.mock('expo-location', () => ({
  hasServicesEnabledAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  Accuracy: { Balanced: 3 },
}));

const location = jest.mocked(Location);

describe('captureLocation', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns {lat,lng} when services are on, permission is granted, and a fix is obtained', async () => {
    location.hasServicesEnabledAsync.mockResolvedValue(true);
    location.requestForegroundPermissionsAsync.mockResolvedValue({ granted: true } as never);
    location.getCurrentPositionAsync.mockResolvedValue({
      coords: { latitude: 12.9, longitude: 77.6 },
    } as never);

    await expect(captureLocation()).resolves.toEqual({ lat: 12.9, lng: 77.6 });
  });

  it('returns undefined when location services are off — no permission prompt', async () => {
    location.hasServicesEnabledAsync.mockResolvedValue(false);

    await expect(captureLocation()).resolves.toBeUndefined();
    expect(location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('returns undefined when permission is denied', async () => {
    location.hasServicesEnabledAsync.mockResolvedValue(true);
    location.requestForegroundPermissionsAsync.mockResolvedValue({ granted: false } as never);

    await expect(captureLocation()).resolves.toBeUndefined();
    expect(location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('returns undefined (never throws) when the fix itself fails', async () => {
    location.hasServicesEnabledAsync.mockResolvedValue(true);
    location.requestForegroundPermissionsAsync.mockResolvedValue({ granted: true } as never);
    location.getCurrentPositionAsync.mockRejectedValue(new Error('timeout'));

    await expect(captureLocation()).resolves.toBeUndefined();
  });
});
