import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SharedPoolModule } from '../shared-pool/shared-pool.module';
import { MeTicketsQueryService } from './me-tickets-query.service';

/** #161 — the merged SE ticket-read surface. See `me-tickets-query.service.ts` for the contract. */
@Module({
  imports: [PrismaModule, SharedPoolModule],
  providers: [MeTicketsQueryService],
  exports: [MeTicketsQueryService],
})
export class MeTicketsModule {}
