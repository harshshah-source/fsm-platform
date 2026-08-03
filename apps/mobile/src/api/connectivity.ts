import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import type { ConnectivitySource } from './writeQueue';

export type ConnectivityState = 'online' | 'offline';

// `isInternetReachable` is `null` until NetInfo has actually probed (or on platforms that don't
// probe), which is common right after boot. Treating that ambiguity as online — rather than
// blocking writes on a signal that may never resolve — matches the queue's own default: a write is
// attempted, and a real network failure is what marks it FAILED/PENDING, not a guess about
// reachability.
function toConnectivityState(state: Pick<NetInfoState, 'isConnected' | 'isInternetReachable'>): ConnectivityState {
  if (state.isConnected === false || state.isInternetReachable === false) {
    return 'offline';
  }
  return 'online';
}

export async function getConnectivityState(): Promise<ConnectivityState> {
  const state = await NetInfo.fetch();
  return toConnectivityState(state);
}

export function subscribeConnectivity(listener: (state: ConnectivityState) => void): () => void {
  return NetInfo.addEventListener((state) => listener(toConnectivityState(state)));
}

/**
 * The production `ConnectivitySource` for `WriteQueue`. Optimistically `online` until the first
 * `NetInfo.fetch()` resolves — a write attempted during that brief window fails on a real network
 * error (→ FAILED, replayed on the next reconnect event) rather than being blocked on a probe that
 * on some platforms never completes.
 */
export function createConnectivitySource(): ConnectivitySource {
  let online = true;
  const listeners = new Set<(online: boolean) => void>();

  void getConnectivityState().then((state) => {
    online = state === 'online';
  });
  subscribeConnectivity((state) => {
    online = state === 'online';
    listeners.forEach((l) => l(online));
  });

  return {
    isOnline: () => online,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
