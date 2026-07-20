import { Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { assertRuntimeBuildGuards } from '../build-info/boot-guard';

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
        // ADR-0025 (timestamptz-UTC): pin the *session* TimeZone to UTC regardless of the Postgres
        // server default. A 2026-07-07 prod audit found the server on Asia/Calcutta; timestamptz
        // interval arithmetic (`now - latest_gps_datetime`) is TZ-independent, so this does not change
        // any inactivity/SLA maths — but it keeps every timestamptz→text render and any `::timestamp`
        // cast honest, so the connection can never reintroduce the IST offset the app deliberately
        // normalizes away at ingest. `options` is passed as the pg startup `-c timezone=UTC` parameter.
        options: '-c timezone=UTC',
      }),
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
