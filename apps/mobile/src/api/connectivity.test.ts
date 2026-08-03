import { afterEach, describe, expect, it, jest } from '@jest/globals';
import NetInfo from '@react-native-community/netinfo';
import { createConnectivitySource, getConnectivityState, subscribeConnectivity } from './connectivity';

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(),
    addEventListener: jest.fn(),
  },
}));

const netInfo = jest.mocked(NetInfo);

describe('connectivity', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('getConnectivityState resolves "online" when NetInfo reports reachable + connected', async () => {
    netInfo.fetch.mockResolvedValue({ isConnected: true, isInternetReachable: true } as never);

    await expect(getConnectivityState()).resolves.toBe('online');
  });

  it('getConnectivityState resolves "offline" when NetInfo reports not connected', async () => {
    netInfo.fetch.mockResolvedValue({ isConnected: false, isInternetReachable: false } as never);

    await expect(getConnectivityState()).resolves.toBe('offline');
  });

  it('getConnectivityState treats an unknown reachability (null) as online rather than blocking writes on ambiguity', async () => {
    netInfo.fetch.mockResolvedValue({ isConnected: true, isInternetReachable: null } as never);

    await expect(getConnectivityState()).resolves.toBe('online');
  });

  it('subscribeConnectivity forwards NetInfo state changes as online/offline and returns an unsubscribe fn', () => {
    const unsubscribe = jest.fn();
    netInfo.addEventListener.mockReturnValue(unsubscribe);
    const listener = jest.fn();

    const unsub = subscribeConnectivity(listener);
    const registeredHandler = netInfo.addEventListener.mock.calls[0][0];
    registeredHandler({ isConnected: true, isInternetReachable: true } as never);
    registeredHandler({ isConnected: false, isInternetReachable: false } as never);

    expect(listener.mock.calls).toEqual([['online'], ['offline']]);
    unsub();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('createConnectivitySource reflects NetInfo state changes synchronously via isOnline()', async () => {
    netInfo.fetch.mockResolvedValue({ isConnected: true, isInternetReachable: true } as never);
    netInfo.addEventListener.mockReturnValue(jest.fn());

    const source = createConnectivitySource();
    await Promise.resolve();
    await Promise.resolve();

    expect(source.isOnline()).toBe(true);

    const registeredHandler = netInfo.addEventListener.mock.calls[0][0];
    registeredHandler({ isConnected: false, isInternetReachable: false } as never);

    expect(source.isOnline()).toBe(false);
  });

  it('createConnectivitySource notifies subscribers on change', () => {
    netInfo.fetch.mockResolvedValue({ isConnected: true, isInternetReachable: true } as never);
    netInfo.addEventListener.mockReturnValue(jest.fn());

    const source = createConnectivitySource();
    const listener = jest.fn();
    source.subscribe(listener);

    const registeredHandler = netInfo.addEventListener.mock.calls[0][0];
    registeredHandler({ isConnected: false, isInternetReachable: false } as never);

    expect(listener).toHaveBeenCalledWith(false);
  });
});
