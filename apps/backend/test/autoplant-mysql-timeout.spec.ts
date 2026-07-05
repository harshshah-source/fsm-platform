import { afterEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import {
  AutoPlantMysqlClient,
  buildPoolOptions,
  readConnectTimeoutMs,
  readQueryTimeoutMs,
} from '../src/ingestion/autoplant/autoplant-mysql.client';

/**
 * Issue 97 Slice 1 (review A4) — fail-fast MySQL timeouts. A packet-blackholing VPN must make a read
 * FAIL within a bounded time rather than hang forever with the run stuck RUNNING. Tested by
 * overriding the raw-driver `execute()` seam with a never-settling promise — no MySQL / VPN needed.
 */
class HangingClient extends AutoPlantMysqlClient {
  // Simulates a driver call that never resolves (VPN swallowed the packet mid-query).
  protected execute<T extends RowDataPacket = RowDataPacket>(): Promise<T[]> {
    return new Promise<T[]>(() => {});
  }
}

/** Records the SQL that reaches the raw-driver seam and returns canned rows — proves the guard/timeout
 *  wrapping without touching MySQL. */
class RecordingClient extends AutoPlantMysqlClient {
  readonly executed: string[] = [];
  constructor(private readonly canned: unknown[] = []) {
    super();
  }
  protected async execute<T extends RowDataPacket = RowDataPacket>(sql: string): Promise<T[]> {
    this.executed.push(sql);
    return this.canned as T[];
  }
}

describe('AutoPlantMysqlClient — fail-fast query timeout (A4)', () => {
  afterEach(() => {
    delete process.env.AUTOPLANT_QUERY_TIMEOUT_MS;
  });

  it('rejects a hung read within the configured timeout instead of hanging', async () => {
    process.env.AUTOPLANT_QUERY_TIMEOUT_MS = '50';
    const client = new HangingClient();
    await expect(client.query('SELECT 1')).rejects.toThrow(/timed out/i);
  });

  it('returns rows for a fast read — the timeout never interferes with the happy path', async () => {
    const client = new RecordingClient([{ n: 42 }]);
    const rows = await client.query('SELECT COUNT(*) AS n FROM tb_vehiclemaster');
    expect(rows).toEqual([{ n: 42 }]);
    expect(client.executed).toEqual(['SELECT COUNT(*) AS n FROM tb_vehiclemaster']);
  });

  it('rejects a non-read query at the guard, before the driver is ever touched', async () => {
    const client = new RecordingClient();
    await expect(client.query('DELETE FROM tb_vehiclemaster')).rejects.toThrow(/read-only/i);
    expect(client.executed).toEqual([]); // guard fired first — execute() never ran
  });

  it('buildPoolOptions carries connectTimeout (default 10000, env-overridable)', () => {
    const cfg = {
      host: 'h',
      port: 3306,
      user: 'u',
      password: 'p',
      dbWidgets: 'ap_widgets',
      dbMasters: 'ap_masters',
      ssl: false,
    };
    expect(buildPoolOptions(cfg, {}).connectTimeout).toBe(10_000);
    expect(buildPoolOptions(cfg, { AUTOPLANT_CONNECT_TIMEOUT_MS: '2500' }).connectTimeout).toBe(2500);
  });

  it('readQueryTimeoutMs defaults to 30000 and honours AUTOPLANT_QUERY_TIMEOUT_MS', () => {
    expect(readQueryTimeoutMs({})).toBe(30_000);
    expect(readQueryTimeoutMs({ AUTOPLANT_QUERY_TIMEOUT_MS: '5000' })).toBe(5_000);
    expect(readQueryTimeoutMs({ AUTOPLANT_QUERY_TIMEOUT_MS: 'garbage' })).toBe(30_000);
    expect(readConnectTimeoutMs({})).toBe(10_000);
  });
});
