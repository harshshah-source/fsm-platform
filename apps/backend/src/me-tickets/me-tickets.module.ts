import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SharedPoolModule } from '../shared-pool/shared-pool.module';
import { MeTicketDetailService } from './me-ticket-detail.service';
import { MeTicketsQueryService } from './me-tickets-query.service';

/**
 * #161 — the SE ticket-read surface: the merged list (item 2, `me-tickets-query.service.ts`) and the
 * per-ticket detail read (item 1, `me-ticket-detail.service.ts`). `MeTicketsController` itself is
 * registered directly on `AppModule` (existing convention for this controller — see `app.module.ts`),
 * not here; this module only supplies its providers.
 */
@Module({
  imports: [PrismaModule, SharedPoolModule],
  providers: [MeTicketsQueryService, MeTicketDetailService],
  exports: [MeTicketsQueryService, MeTicketDetailService],
})
export class MeTicketsModule {}
