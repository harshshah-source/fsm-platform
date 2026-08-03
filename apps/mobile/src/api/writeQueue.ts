export type WriteStatus = 'PENDING' | 'SYNCED' | 'FAILED';

export interface ConnectivitySource {
  isOnline(): boolean;
  /** Returns an unsubscribe function. */
  subscribe(listener: (online: boolean) => void): () => void;
}

interface QueueRecord {
  execute: () => Promise<unknown>;
  status: WriteStatus;
}

/**
 * #54 offline seam: a write issued while offline is held here as PENDING and replayed the moment
 * connectivity returns. In-memory only — durable persistence across app restarts and the batched
 * `POST /api/sync/batch` flush are Issue 17, not this one.
 */
export class WriteQueue {
  private records = new Map<string, QueueRecord>();
  private nextId = 0;

  constructor(private connectivity: ConnectivitySource) {
    this.connectivity.subscribe((online) => {
      if (online) {
        void this.replayPending();
      }
    });
  }

  enqueue(execute: () => Promise<unknown>): string {
    const id = String(this.nextId++);
    this.records.set(id, { execute, status: 'PENDING' });
    if (this.connectivity.isOnline()) {
      void this.attempt(id);
    }
    return id;
  }

  getStatus(id: string): WriteStatus | undefined {
    return this.records.get(id)?.status;
  }

  private async attempt(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) {
      return;
    }
    try {
      await record.execute();
      record.status = 'SYNCED';
    } catch {
      record.status = 'FAILED';
    }
  }

  private async replayPending(): Promise<void> {
    for (const [id, record] of this.records) {
      if (record.status === 'PENDING') {
        await this.attempt(id);
      }
    }
  }
}
