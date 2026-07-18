import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import mysql, { type Pool, type PoolOptions, type RowDataPacket } from 'mysql2/promise';

/**
 * Read-only connection to the AutoPlant production MySQL DB (reachable over VPN) — the Snapshot
 * ingestion source (Issue 04). This is the CONNECTION SEAM ONLY: it proves the app can reach and
 * read AutoPlant. The full `SourceReader` mapping — `gpssignal` JSON extraction, UTC normalization,
 * device-id handling, status-vocab normalization — is intentionally NOT here yet (parked).
 *
 * The pool is created lazily on first query, so an unset config (dev / test / CI) never blocks app
 * boot: the app runs fine without AutoPlant, and the SnapshotIngestionWorker keeps using its
 * in-memory reader until the real SourceReader is wired behind SOURCE_READER.
 *
 * `dateStrings: true` returns DATETIME columns as raw wall-clock strings (no implicit driver
 * timezone conversion), so the timezone decision stays with our normalizer — not the MySQL driver.
 */
export interface AutoPlantMysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** `ap_widgets` — live telemetry (tb_vehiclemaster); queried schema-qualified, NOT the connection
   *  default (the production account has no grant on it — see `buildPoolOptions`). */
  dbWidgets: string;
  /** `ap_masters` — master data (mst_company/plant/vehicle/transporter); queried schema-qualified. */
  dbMasters: string;
  ssl: boolean;
}

/**
 * Read the AutoPlant MySQL config from env; returns null when not configured (env unset), so the
 * app boots without it and the SnapshotIngestionWorker keeps using its in-memory reader.
 *
 * The production source spans TWO databases on one host: `ap_widgets` (telemetry) and `ap_masters`
 * (masters). Both must be set. Back-compat: the legacy single `AUTOPLANT_MYSQL_DATABASE` seeds
 * `dbWidgets` (where tb_vehiclemaster lives) so an existing dev `.env` keeps working for the ping.
 */
export function readAutoPlantMysqlConfig(env: NodeJS.ProcessEnv = process.env): AutoPlantMysqlConfig | null {
  const host = env.AUTOPLANT_MYSQL_HOST;
  const user = env.AUTOPLANT_MYSQL_USER;
  const password = env.AUTOPLANT_MYSQL_PASSWORD;
  const dbWidgets = env.AUTOPLANT_MYSQL_DB_WIDGETS ?? env.AUTOPLANT_MYSQL_DATABASE;
  const dbMasters = env.AUTOPLANT_MYSQL_DB_MASTERS;
  if (!host || !user || !password || !dbWidgets || !dbMasters) return null;
  return {
    host,
    port: env.AUTOPLANT_MYSQL_PORT ? Number(env.AUTOPLANT_MYSQL_PORT) : 3306,
    user,
    password,
    dbWidgets,
    dbMasters,
    ssl: env.AUTOPLANT_MYSQL_SSL === 'true',
  };
}

const READ_ONLY_PREFIXES = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'] as const;

/** Fail-fast defaults (Issue 97 / review A4). A packet-blackholing VPN must surface as a bounded
 *  rejection, not an indefinitely-pending read that pins the run RUNNING. Both env-overridable. */
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Per-statement timeout budget. Kept OUT of `AutoPlantMysqlConfig` on purpose: config nullability
 * signals "credentials present" (drives the mock/real DI swap), whereas the timeout is always known —
 * even to decide how long to wait before giving up on an unconfigured/hung read.
 */
export function readQueryTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AUTOPLANT_QUERY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_QUERY_TIMEOUT_MS;
}

/** TCP connect budget for the pool (mysql2 `connectTimeout`). */
export function readConnectTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AUTOPLANT_CONNECT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONNECT_TIMEOUT_MS;
}

/** Pure builder for the mysql2 pool options — testable without opening a pool. */
export function buildPoolOptions(
  cfg: AutoPlantMysqlConfig,
  env: NodeJS.ProcessEnv = process.env,
): PoolOptions {
  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    // Default schema = the MASTERS schema. MySQL validates the default database at CONNECT time, so
    // this must name a schema the account can actually reach; the master-sync pipeline reads ap_masters
    // and is fully schema-qualified, so any valid default works.
    //
    // Every read of ap_widgets MUST be schema-qualified rather than leaning on this default — an
    // unqualified `FROM tb_vehiclemaster` resolves to ap_masters, where it does not exist, and fails
    // ER_NO_SUCH_TABLE (this broke snapshot runs 64–70 on 2026-07-14/15).
    //
    // 2026-07-17 correction: earlier comments here claimed ap_widgets "does not exist" on the
    // production account / was "parked pending the telemetry-source grant". That is NOT true — a live
    // read of `ap_widgets`.tb_vehiclemaster returns current telemetry (verified fresh to the same day),
    // and both the snapshot reader and the master sync's device-identity join depend on it. The
    // original connect failure was about the DEFAULT schema, not the grant.
    database: cfg.dbMasters,
    ssl: cfg.ssl ? {} : undefined,
    connectionLimit: 4,
    waitForConnections: true,
    dateStrings: true,
    // Fail-fast on a dead/half-open VPN rather than blocking on connection acquisition.
    connectTimeout: readConnectTimeoutMs(env),
  };
}

/**
 * Reject `work` if it doesn't settle within `ms` — the per-statement fail-fast wrapper. On timeout it
 * rejects with a clear error (the pending `work` is abandoned; the pool connection is reclaimed by
 * mysql2). A non-positive `ms` disables the wrapper (returns `work` unchanged).
 */
export async function withQueryTimeout<T>(work: Promise<T>, ms: number, sql: string): Promise<T> {
  if (!(ms > 0)) return work;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`AutoPlant query timed out after ${ms}ms: "${sql.slice(0, 48)}…"`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

@Injectable()
export class AutoPlantMysqlClient implements OnModuleDestroy {
  private readonly logger = new Logger(AutoPlantMysqlClient.name);
  private pool: Pool | null = null;

  /** True when the two-schema AutoPlant env is set — lets the health surface report "configured but
   * unreachable" (VPN down) distinctly from "not configured" (dev/test/CI), without opening a pool. */
  isConfigured(): boolean {
    return readAutoPlantMysqlConfig() !== null;
  }

  private getPool(): Pool {
    if (this.pool) return this.pool;
    const cfg = readAutoPlantMysqlConfig();
    if (!cfg) {
      throw new Error(
        'AutoPlant MySQL not configured — set AUTOPLANT_MYSQL_HOST/USER/PASSWORD/DATABASE ' +
          '(+ optional AUTOPLANT_MYSQL_PORT, AUTOPLANT_MYSQL_SSL).',
      );
    }
    this.logger.log(
      `Opening AutoPlant MySQL pool ${cfg.user}@${cfg.host}:${cfg.port} ` +
        `(default=${cfg.dbMasters}, widgets=${cfg.dbWidgets}, ssl=${cfg.ssl})`,
    );
    this.pool = mysql.createPool(buildPoolOptions(cfg));
    return this.pool;
  }

  /**
   * The raw pool call. Extracted as a `protected` seam so tests can simulate a hung/failed driver
   * (a VPN half-failure) without a real MySQL connection. Production code should call `query()`, which
   * wraps this with the read-only guard and the fail-fast timeout.
   */
  protected async execute<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    params: readonly unknown[],
  ): Promise<T[]> {
    const [rows] = await this.getPool().query<T[]>(sql, params as unknown[]);
    return rows;
  }

  /**
   * Run a read-only query. A defensive guard rejects anything that is not a plain read — this seam
   * must never mutate the production source, regardless of what the account is granted. The read is
   * bounded by a per-statement timeout (review A4) so a dead VPN fails fast instead of hanging.
   */
  async query<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const head = sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? '';
    if (!READ_ONLY_PREFIXES.includes(head as (typeof READ_ONLY_PREFIXES)[number])) {
      throw new Error(`Refusing non-read query at the read-only AutoPlant seam: "${sql.slice(0, 48)}…"`);
    }
    return withQueryTimeout(this.execute<T>(sql, params), readQueryTimeoutMs(), sql);
  }

  /**
   * Connectivity probe: confirms the pool connects and the masters schema is readable, schema-qualified
   * so it never leans on the connection default. `vehicleRows` = mst_vehicle count. Deliberately scoped
   * to masters: it is the FK-ordered root of the sync, so a masters failure is the one that stops
   * everything. (The widgets schema IS readable — see `buildPoolOptions`; `autoplant-ping.ts` probes it
   * separately.)
   */
  async ping(): Promise<{ ok: true; vehicleRows: number }> {
    const cfg = readAutoPlantMysqlConfig();
    if (!cfg) {
      throw new Error('AutoPlant MySQL not configured — set the AUTOPLANT_MYSQL_* env before pinging.');
    }
    const rows = await this.query(`SELECT COUNT(*) AS n FROM \`${cfg.dbMasters}\`.mst_vehicle`);
    return { ok: true, vehicleRows: Number((rows[0] as { n?: number | string })?.n ?? 0) };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
