import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Single Prisma connection for the process, tied to the Nest lifecycle. Prisma 7 has no
 * bundled query engine — it connects through a driver adapter (`@prisma/adapter-pg` over
 * `pg`) built from DATABASE_URL. The public surface is PrismaClient + connect/disconnect;
 * transaction-scoped audit (TB6) composes on top of `$transaction`, not inside this service.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
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
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
