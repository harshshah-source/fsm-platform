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
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
