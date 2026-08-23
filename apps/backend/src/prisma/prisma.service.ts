import { Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { assertRuntimeBuildGuards } from '../build-info/boot-guard';
import { transactionOptions } from './transaction-options';

/** Positive-integer env read with a default; a blank/garbage value falls back rather than NaN-ing. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * #106 / Wave 0 — connection-pool and timeout posture.
 *
 * Before this, `PrismaPg` was constructed with only a connection string, so the process ran on
 * node-postgres defaults: **max 10** connections and **`connectionTimeoutMillis: 0`** (wait
 * forever), against a database with `statement_timeout = 0` and
 * `idle_in_transaction_session_timeout = 0`. That combination has no failure mode that surfaces as
 * an error — it degrades into unbounded queueing, which is the worst diagnostic shape and the one a
 * retrying mobile client cannot react to.
 *
 * `POOL_MAX` 25: measured headroom is `max_connections = 100` with ~6 in use cluster-wide, and this
 * process also hosts 13 in-process crons that compete for the same pool.
 *
 * `ACQUIRE_TIMEOUT_MS` 5000: the point is the *backpressure signal*. A request that cannot get a
 * connection must fail fast so the caller learns the server is saturated; queueing forever means a
 * mobile retry loop stacks on top of the queue invisibly.
 *
 * `STATEMENT_TIMEOUT_MS` 120000 — deliberately generous, and lower than it looks like it should be.
 * The goal here is to bound a *stuck* query, not to police slow ones: this process runs set-based
 * recomputes, a materialized-view refresh and zone-wide dispatch transactions whose per-statement
 * cost has never been measured. A 30s cap would risk killing legitimate sweep work, which would be a
 * self-inflicted outage in the name of preventing one. Tighten it once per-statement timings exist.
 *
 * `IDLE_IN_TX_TIMEOUT_MS` 60000: this only fires on a transaction that is open but not executing —
 * i.e. exactly the leaked-connection case, never healthy work.
 */
function poolOptions(): { max: number; connectionTimeoutMillis: number; options: string } {
  const statementTimeoutMs = envInt('DB_STATEMENT_TIMEOUT_MS', 120_000);
  const idleInTxTimeoutMs = envInt('DB_IDLE_IN_TX_TIMEOUT_MS', 60_000);
  return {
    max: envInt('DB_POOL_MAX', 25),
    connectionTimeoutMillis: envInt('DB_POOL_ACQUIRE_TIMEOUT_MS', 5_000),
    // ADR-0025 (timestamptz-UTC): pin the *session* TimeZone to UTC regardless of the Postgres
    // server default. A 2026-07-07 prod audit found the server on Asia/Calcutta; timestamptz
    // interval arithmetic (`now - latest_gps_datetime`) is TZ-independent, so this does not change
    // any inactivity/SLA maths — but it keeps every timestamptz→text render and any `::timestamp`
    // cast honest, so the connection can never reintroduce the IST offset the app deliberately
    // normalizes away at ingest. Passed as pg startup `-c` parameters.
    options: `-c timezone=UTC -c statement_timeout=${statementTimeoutMs} -c idle_in_transaction_session_timeout=${idleInTxTimeoutMs}`,
  };
}

export interface PrismaServiceOptions {
  /**
   * #130 — read-only tools (autoplant:ping, departure-dryrun, runtime-lock:reset) construct the
   * service in warnOnly mode: the boot guard evaluates and WARNs on a stale/skewed build but never
   * writes the lock and never throws, so a diagnostic never gets blocked by the lock it inspects.
   */
  warnOnly?: boolean;
}

/**
 * Single Prisma connection for the process, tied to the Nest lifecycle. Prisma 7 has no
 * bundled query engine — it connects through a driver adapter (`@prisma/adapter-pg` over
 * `pg`) built from DATABASE_URL. The public surface is PrismaClient + connect/disconnect;
 * transaction-scoped audit (TB6) composes on top of `$transaction`, not inside this service.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly warnOnly: boolean;

  constructor(@Optional() options: PrismaServiceOptions = {}) {
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        ...poolOptions(),
      }),
      // #262 item 5 — a stated policy, not Prisma's unconfigured 2 s/5 s. See `transaction-options.ts`
      // for the reasoning; the short version is that a zone-wide dispatch used to be one interactive
      // transaction and 5 s was a production cliff nobody had chosen.
      transactionOptions: transactionOptions(),
    });
    this.warnOnly = options.warnOnly ?? false;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    // #130 — structural build guard: refuse a stale/skewed build BEFORE any query runs. Living here
    // (not in main.ts) means every entrypoint — the Nest app and hand-constructed scripts alike —
    // runs it, so no future one-off writer can bypass it. Read-only tools pass warnOnly.
    await assertRuntimeBuildGuards(this, {
      warnOnly: this.warnOnly,
      warn: (message) => this.logger.warn(message),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
