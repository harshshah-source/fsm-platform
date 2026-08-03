import { describe, expect, it, jest } from '@jest/globals';
import { WriteQueue, type ConnectivitySource } from './writeQueue';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeConnectivity(initialOnline: boolean): {
  source: ConnectivitySource;
  setOnline: (online: boolean) => void;
} {
  let online = initialOnline;
  const listeners: ((online: boolean) => void)[] = [];
  return {
    source: {
      isOnline: () => online,
      subscribe: (cb) => {
        listeners.push(cb);
        return () => {
          const i = listeners.indexOf(cb);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    },
    setOnline: (next: boolean) => {
      online = next;
      listeners.forEach((l) => l(next));
    },
  };
}

describe('WriteQueue', () => {
  it('reports PENDING and does not execute the write while offline', () => {
    const { source } = fakeConnectivity(false);
    const queue = new WriteQueue(source);
    const execute = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const id = queue.enqueue(execute);

    expect(queue.getStatus(id)).toBe('PENDING');
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes immediately and reports SYNCED for a write issued while online', async () => {
    const { source } = fakeConnectivity(true);
    const queue = new WriteQueue(source);
    const execute = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const id = queue.enqueue(execute);
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(queue.getStatus(id)).toBe('SYNCED');
  });

  it('replays a PENDING write when connectivity returns, marking it SYNCED', async () => {
    const { source, setOnline } = fakeConnectivity(false);
    const queue = new WriteQueue(source);
    const execute = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const id = queue.enqueue(execute);

    setOnline(true);
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(queue.getStatus(id)).toBe('SYNCED');
  });

  it('marks a write FAILED (not lost) if replay throws', async () => {
    const { source, setOnline } = fakeConnectivity(false);
    const queue = new WriteQueue(source);
    const execute = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('network error'));
    const id = queue.enqueue(execute);

    setOnline(true);
    await flushMicrotasks();

    expect(queue.getStatus(id)).toBe('FAILED');
  });

  it('does not re-execute a write already SYNCED on a second connectivity-restored event', async () => {
    const { source, setOnline } = fakeConnectivity(true);
    const queue = new WriteQueue(source);
    const execute = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    queue.enqueue(execute);
    await flushMicrotasks();

    setOnline(false);
    setOnline(true);
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
