import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';

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
  /** `ap_widgets` — live telemetry (tb_vehiclemaster); the connection's DEFAULT schema. */
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

@Injectable()
export class AutoPlantMysqlClient implements OnModuleDestroy {
  private readonly logger = new Logger(AutoPlantMysqlClient.name);
  private pool: Pool | null = null;

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
        `(default=${cfg.dbWidgets}, masters=${cfg.dbMasters}, ssl=${cfg.ssl})`,
    );
    this.pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      // Default schema = ap_widgets (tb_vehiclemaster); ap_masters queries are schema-qualified.
      database: cfg.dbWidgets,
      ssl: cfg.ssl ? {} : undefined,
      connectionLimit: 4,
      waitForConnections: true,
      dateStrings: true,
    });
    return this.pool;
  }

  /**
   * Run a read-only query. A defensive guard rejects anything that is not a plain read — this seam
   * must never mutate the production source, regardless of what the account is granted.
   */
  async query<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const head = sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? '';
    if (!READ_ONLY_PREFIXES.includes(head as (typeof READ_ONLY_PREFIXES)[number])) {
      throw new Error(`Refusing non-read query at the read-only AutoPlant seam: "${sql.slice(0, 48)}…"`);
    }
    const [rows] = await this.getPool().query<T[]>(sql, params as unknown[]);
    return rows;
  }

  /** Connectivity probe: confirms the pool connects and the source table is readable. */
  async ping(): Promise<{ ok: true; vehicleRows: number }> {
    const rows = await this.query('SELECT COUNT(*) AS n FROM tb_vehiclemaster');
    return { ok: true, vehicleRows: Number((rows[0] as { n?: number | string })?.n ?? 0) };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
